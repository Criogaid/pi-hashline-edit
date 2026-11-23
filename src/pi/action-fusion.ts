/**
 * Action Fusion: run an optional `then_run` command after a successful mutation.
 *
 * Two per-file queues nest here, with different jobs:
 * - Pi's `withFileMutationQueue` (entered by the mutation runner) serializes
 *   the read-modify-write itself and is shared with every tool that uses it.
 *   It is released as soon as the file is published.
 * - The scheduler's own queue wraps mutation, freshness check, and command, so
 *   a later fused call on the same file waits until this command finishes and
 *   cannot change the revision the command started from. Its key resolves the nearest
 *   existing ancestor and folds case on Windows, so it is never looser than
 *   Pi's key. Nested tool calls during the command cannot wait on an occupied
 *   Fusion queue: they might be waiting for their own command to finish.
 *
 * Writers outside these queues are not blocked; the commit layer's freshness
 * observation against `publishedRevision` detects them, and the command is
 * skipped or the result reports the changed freshness. A failed command never
 * rolls back the published file. Fusion states only the command: its status,
 * output, and termination request; the file state belongs to the mutation result.
 *
 * @module pi-hashline-edit/pi
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { addAbortListener } from "node:events";
import { realpath } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import type { AgentToolUpdateCallback } from "@earendil-works/pi-agent-core";
import { contentText } from "@earendil-works/pi-ai";
import type {
  BashToolCallEvent,
  ExtensionToolContext,
  ToolCallEvent,
} from "@earendil-works/pi-coding-agent";
import type { ThenRunInput } from "./fusion-arguments.ts";
import { MILLISECONDS_PER_SECOND, MAX_BASH_TIMEOUT_SECONDS } from "./fusion-arguments.ts";
import { observeFreshness, type FreshnessObservation } from "./file-commit.ts";
import { projectBashDetails } from "./fusion-card.ts";
import { snapshotBashOutput } from "./native-bash.ts";
import type {
  CommandFacts,
  MutationCommandFacts,
  MutationResultDetails,
  MutationScheduler,
} from "./mutation-result.ts";
import { errnoCode, errorMessage, HashlineError } from "../core/errors.ts";
import { cancellationError, throwIfCancelled } from "./error-text.ts";
import { Value } from "typebox/value";
import { COMMAND_IMAGE_SCHEMA } from "./report-schema.ts";
import type {
  ActionFusionProgress,
  CommandResult,
  CommandStatus,
  Freshness,
} from "./report-schema.ts";

// The one place the model is told when to use then_run; the tools' descriptions stay their own.
export const ACTION_FUSION_GUIDELINES = [
  `Set then_run on edit, replace, or write for a check that can run right after that change. Use a separate bash call when the command requires approval, needs information from the tool's result, must wait for reload, or covers several changes; run that check once after all of them.${
    // Pi's Bash runs on this host, and Pi's prompt does not name the OS; only Windows needs the path note.
    process.platform === "win32"
      ? " then_run commands run in Bash on Windows: avoid Unix-only paths such as /tmp."
      : ""
  }`,
];

type ProgressReporter = (progress: ActionFusionProgress) => void;

interface BashCallScope {
  readonly toolCallId: string;
  input?: BashToolCallEvent["input"] | Record<string, unknown>;
}

const bashCallScope = new AsyncLocalStorage<BashCallScope>();

/** Retain the args Pi shares with the remaining permission hooks and the nested Bash call. */
export function observeFusionToolCall(event: ToolCallEvent): void {
  const scope = bashCallScope.getStore();
  if (scope && event.parentToolCallId === scope.toolCallId && event.toolName === "bash") {
    scope.input = event.input;
  }
}

async function canonicalQueueKey(path: string): Promise<string> {
  const folded = (key: string) => (process.platform === "win32" ? key.toLowerCase() : key);
  const resolved = resolve(path);
  let current = resolved;
  const missing: string[] = [];
  while (true) {
    try {
      return folded(resolve(await realpath(current), ...missing));
    } catch (error) {
      const code = errnoCode(error);
      if (code !== "ENOENT" && code !== "ENOTDIR") throw error;
      const parent = dirname(current);
      if (parent === current) return folded(resolved);
      missing.unshift(basename(current));
      current = parent;
    }
  }
}

function bashTimeoutSeconds(timeout: unknown): number | undefined {
  if (typeof timeout === "number" && timeout > 0 && timeout <= MAX_BASH_TIMEOUT_SECONDS)
    return timeout;
}

/** Session listeners can replace array methods and block properties. Read indexed values once. */
function snapshotOutput(
  source: CommandResult["content"],
  recordObserverFailure: (error: unknown) => void,
) {
  const content: CommandResult["content"] = [];
  const length = source.length;
  for (let i = 0; i < length; i++) {
    if (!(i in source)) continue;
    const block = source[i];
    const type = block.type;
    if (type === "text") {
      const { text, textSignature } = block;
      if (typeof text !== "string") throw new Error("Invalid then_run text block.");
      content.push(
        typeof textSignature === "string" ? { type, text, textSignature } : { type, text },
      );
      continue;
    }
    if (type !== "image") throw new Error("Invalid then_run content block type.");
    try {
      const image = { type, data: block.data, mimeType: block.mimeType };
      if (!Value.Check(COMMAND_IMAGE_SCHEMA, image))
        throw new Error("Invalid then_run image block.");
      content.push(image);
    } catch (error) {
      recordObserverFailure(error);
    }
  }
  return content;
}

/**
 * Coordinates one session Bash call and its display. Display callbacks are observers.
 * Their failures are kept for the report without affecting publication or execution.
 * Fusion owns the heartbeat lifetime. Pi Bash owns timeout and process cleanup.
 */
function createBashCallCoordinator<TDetails extends object>({
  toolCallId,
  commandText,
  onProgress,
  onUpdate,
  recordCommand,
}: {
  toolCallId: string;
  commandText: string;
  onProgress: ProgressReporter;
  onUpdate: AgentToolUpdateCallback<MutationResultDetails<TDetails>>;
  recordCommand: (facts: MutationCommandFacts) => void;
}) {
  const bashCall: BashCallScope = { toolCallId };
  let mutationDetails: TDetails | undefined;
  let displayedCommand = commandText;
  let commandResult: CommandResult | undefined;
  let finalStatus: CommandStatus | undefined;
  let launchTimeoutSeconds: number | undefined;
  /** A command with a timeout counts down once Bash first reports, refreshed by its heartbeat. */
  let countdown:
    | {
        readonly timeoutSeconds: number;
        readonly deadlineMs: number;
        readonly heartbeat: ReturnType<typeof setInterval>;
      }
    | undefined;

  const recordObserverFailure = (error: unknown) => recordCommand({ progressFailure: { error } });

  const recordStatus = (status: CommandStatus) => {
    finalStatus = status;
    recordCommand({ status });
  };

  const report = (command: ActionFusionProgress["command"], freshness: Freshness) => {
    const progress: ActionFusionProgress = {
      toolCallId,
      commandText: displayedCommand,
      command,
      freshness,
      ...(commandResult ? { result: commandResult } : {}),
      mutationCompleted: mutationDetails !== undefined,
      ...(countdown
        ? {
            timing: {
              timeoutSeconds: countdown.timeoutSeconds,
              remainingSeconds: Math.max(
                0,
                Math.ceil((countdown.deadlineMs - Date.now()) / MILLISECONDS_PER_SECOND),
              ),
            },
          }
        : {}),
    };
    for (const notify of [
      () => onProgress(progress),
      () => onUpdate({ content: [], details: { ...mutationDetails, actionFusion: progress } }),
    ]) {
      try {
        notify();
      } catch (error) {
        recordObserverFailure(error);
      }
    }
  };

  const followCommand: AgentToolUpdateCallback<unknown> = (partial) => {
    // Built-in Bash first updates at launch, after permission hooks and before result hooks.
    if (bashCall.input) {
      const { command, timeout } = bashCall.input;
      delete bashCall.input;
      if (typeof command === "string") displayedCommand = command;
      launchTimeoutSeconds = bashTimeoutSeconds(timeout);
      if (launchTimeoutSeconds !== undefined) {
        const deadlineMs = Date.now() + launchTimeoutSeconds * MILLISECONDS_PER_SECOND;
        const heartbeat = setInterval(() => report("running", "unknown"), MILLISECONDS_PER_SECOND);
        heartbeat.unref();
        countdown = { timeoutSeconds: launchTimeoutSeconds, deadlineMs, heartbeat };
      }
    }
    commandResult = { content: partial.content, details: partial.details };
    report("running", "unknown");
  };

  function failCommand(status: "failed" | "cancelled", message: string): CommandFacts {
    recordStatus(status);
    return snapshotCommand({ content: [{ type: "text", text: message }] }, status, undefined);
  }

  async function runCommand(
    thenRun: ThenRunInput,
    signal: AbortSignal,
    ctx: ExtensionToolContext,
  ): Promise<CommandFacts> {
    let completion;
    let hookInput;
    try {
      completion = await bashCallScope.run(bashCall, () =>
        ctx.executeTool("bash", thenRun, { onUpdate: followCommand }),
      );
    } catch (error) {
      const status = signal.aborted ? "cancelled" : "failed";
      return failCommand(status, errorMessage(error));
    } finally {
      hookInput = bashCall.input;
      delete bashCall.input;
      if (countdown) clearInterval(countdown.heartbeat);
    }

    return readCompletion(completion, hookInput, signal);
  }

  function snapshotCommand(
    result: CommandResult,
    status: Exclude<CommandStatus, "skipped">,
    structured: ReturnType<typeof snapshotBashOutput>["structured"],
    content = snapshotOutput(result.content, recordObserverFailure),
  ): CommandFacts {
    // Progress subscribers may mutate the card's blocks before the mutation is finalized.
    commandResult = { content: content.map((block) => ({ ...block })) };
    try {
      const details = projectBashDetails(result.details);
      if (details !== undefined) commandResult.details = details;
    } catch (error) {
      recordObserverFailure(error);
    }
    return { script: { status, ...structured }, content };
  }

  function readCompletion(
    { result, isError, durationMs }: Awaited<ReturnType<ExtensionToolContext["executeTool"]>>,
    hookInput: BashCallScope["input"],
    signal: AbortSignal,
  ): CommandFacts {
    // Keep a safe terminal card even if reading the final output fails.
    commandResult = { content: [] };
    if (!isError) recordStatus("succeeded");
    const terminate = result.terminate;
    if (typeof terminate === "boolean") recordCommand({ terminate });
    const { exited, structured } = snapshotBashOutput(result, recordObserverFailure);
    if (!isError) return snapshotCommand(result, "succeeded", structured);

    const finishError = (
      status: "failed" | "timeout" | "cancelled",
      snapshot?: ReturnType<typeof snapshotOutput>,
    ): CommandFacts => {
      recordStatus(status);
      return snapshotCommand(result, status, structured, snapshot);
    };

    if (exited) return finishError("failed");
    if (durationMs === undefined) {
      if (!signal.aborted) return finishError("failed");
      recordStatus("cancelled");
      commandResult = undefined;
      return { script: { status: "cancelled" }, content: [] };
    }
    const timeout = launchTimeoutSeconds ?? bashTimeoutSeconds(hookInput?.timeout);
    if (timeout === undefined) return finishError(signal.aborted ? "cancelled" : "failed");
    const snapshot = snapshotOutput(result.content, recordObserverFailure);
    const text = contentText(snapshot);
    const diagnostic = `Command timed out after ${timeout} seconds`;
    if (text === diagnostic || text.endsWith(`\n${diagnostic}`))
      return finishError("timeout", snapshot);
    return finishError(signal.aborted ? "cancelled" : "failed", snapshot);
  }

  return {
    report,
    runCommand,
    failCommand,
    reportCompletion() {
      if (finalStatus !== undefined) report(finalStatus, "unknown");
    },
    mutationCompleted(details: TDetails) {
      mutationDetails = details;
    },
  };
}

/** The scheduler of mutation calls when Action Fusion is on, shared by every mutation tool. */
export function createActionFusionScheduler(onProgress: ProgressReporter): MutationScheduler {
  const queueTails = new Map<string, Promise<void>>();
  const commandScope = new AsyncLocalStorage<{ active: boolean }>();

  async function withQueue<T>(
    path: string,
    signal: AbortSignal,
    work: () => Promise<T>,
  ): Promise<T> {
    const key = await canonicalQueueKey(path);
    const previous = queueTails.get(key);
    if (previous && commandScope.getStore()?.active) {
      throw new Error(
        "A then_run command cannot call a mutation tool for a target with a pending mutation.",
      );
    }
    const owned = Promise.withResolvers<void>();
    const tail = previous ? previous.then(() => owned.promise) : owned.promise;
    queueTails.set(key, tail);
    // A cancelled waiter releases its own turn, while its predecessor still owns the queue.
    void tail.then(() => {
      if (queueTails.get(key) === tail) queueTails.delete(key);
    });
    try {
      if (previous) {
        const cancelled = Promise.withResolvers<never>();
        const subscription = addAbortListener(signal, () => cancelled.reject(cancellationError()));
        try {
          await Promise.race([previous, cancelled.promise]);
        } finally {
          subscription[Symbol.dispose]();
        }
      } else {
        await previous;
      }
      throwIfCancelled(signal);
      return await work();
    } finally {
      owned.resolve();
    }
  }

  const schedule: MutationScheduler = async ({
    toolCallId,
    absolutePath,
    thenRun,
    mutate,
    signal,
    ctx,
    onUpdate,
    recordCommand,
  }) => {
    // Without a command, the mutation still waits for a fused call on the same file.
    if (thenRun === undefined)
      return withQueue(absolutePath, signal, async () => ({
        kind: "alone" as const,
        outcome: await mutate(),
      }));

    const progress = createBashCallCoordinator({
      toolCallId,
      commandText: "command" in thenRun ? thenRun.command : thenRun.commandText,
      onProgress,
      onUpdate,
      recordCommand,
    });
    const notRun = (status: "skipped" | "cancelled") => {
      recordCommand({ status });
      progress.report(status, "unknown");
    };
    progress.report("waiting", "unknown");
    let started = false;
    return withQueue(absolutePath, signal, async () => {
      started = true;
      const outcome = await mutate().catch((error: unknown) => {
        notRun("skipped");
        throw error;
      });
      progress.mutationCompleted(outcome.details);

      const { publishedRevision } = outcome.commit;
      progress.report("waiting", "unknown");
      const settle = (observation: FreshnessObservation, command: CommandFacts) => {
        progress.report(command.script.status, observation.freshness);
        return {
          kind: "fused" as const,
          outcome,
          observation,
          command,
        };
      };

      if ("error" in thenRun)
        return settle(outcome.commit, progress.failCommand("failed", thenRun.error));

      // A completed mutation remains successful; the command is only started on a fresh target.
      const before = await observeFreshness(absolutePath, publishedRevision, "before-command");
      const beforeStatus = signal.aborted
        ? "cancelled"
        : before.freshness !== "unchanged"
          ? "skipped"
          : undefined;
      if (beforeStatus !== undefined) {
        recordCommand({ status: beforeStatus });
        return settle(before, { script: { status: beforeStatus }, content: [] });
      }

      progress.report("running", "unchanged");
      const scope = { active: true };
      try {
        const command = await commandScope
          .run(scope, () => progress.runCommand(thenRun, signal, ctx))
          .finally(() => {
            scope.active = false;
          });
        return settle(
          await observeFreshness(absolutePath, publishedRevision, "after-command"),
          command,
        );
      } catch (error) {
        progress.reportCompletion();
        throw error;
      }
    }).catch((error: unknown) => {
      if (started) throw error;
      const cancelled = error instanceof HashlineError && error.errorCode === "OPERATION_ABORTED";
      notRun(cancelled ? "cancelled" : "skipped");
      throw error;
    });
  };
  return schedule;
}
