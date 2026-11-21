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
import { Type, type Static, type TObject, type TProperties } from "typebox";
import { observeFreshness, type FreshnessObservation } from "./file-commit.ts";
import {
  CommandNotRun,
  type CommandFacts,
  type MutationResultDetails,
  type MutationScheduler,
  type ObserverFailure,
} from "./mutation-result.ts";
import { errnoCode, errorMessage, HashlineError } from "../core/errors.ts";
import { cancellationError, throwIfCancelled } from "./error-text.ts";
import type {
  ActionFusionProgress,
  CommandResult,
  CommandStatus,
  Freshness,
  MutationToolName,
} from "./report-schema.ts";

const MILLISECONDS_PER_SECOND = 1_000;

// Pi's built-in Bash rejects timeouts above the setTimeout millisecond limit.
const MAX_BASH_TIMEOUT_SECONDS = 2_147_483_647 / MILLISECONDS_PER_SECOND;

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

function createThenRunSchema(tool: MutationToolName) {
  return Type.Optional(
    Type.Object(
      {
        command: Type.String({ pattern: "\\S", description: "Bash command to run." }),
        timeout: Type.Optional(
          Type.Number({
            exclusiveMinimum: 0,
            maximum: MAX_BASH_TIMEOUT_SECONDS,
            description: "Timeout in seconds; none when omitted.",
          }),
        ),
      },
      {
        description: `Command to run once after ${tool} succeeds; failure does not roll back the file.`,
        additionalProperties: false,
      },
    ),
  );
}

/** Add the optional then_run field to a mutation schema when Action Fusion is enabled. */
export function withThenRunSchema<P extends TProperties>(
  schema: TObject<P>,
  tool: MutationToolName,
  actionFusion: boolean,
): TObject<P> | TObject<P & { then_run: ReturnType<typeof createThenRunSchema> }> {
  return actionFusion
    ? Type.Object(
        { ...schema.properties, then_run: createThenRunSchema(tool) },
        { additionalProperties: false },
      )
    : schema;
}

export type ThenRunInput = NonNullable<Static<ReturnType<typeof createThenRunSchema>>>;

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

/**
 * Coordinates one session Bash call and its display. Display callbacks are observers.
 * Their failures are kept for the report without affecting publication or execution.
 * Fusion owns the heartbeat lifetime. Pi Bash owns timeout and process cleanup.
 */
function createBashCallCoordinator<TDetails extends object>({
  toolCallId,
  thenRun,
  onProgress,
  onUpdate,
}: {
  toolCallId: string;
  thenRun: ThenRunInput;
  onProgress: ProgressReporter;
  onUpdate: AgentToolUpdateCallback<MutationResultDetails<TDetails>>;
}) {
  const bashCall: BashCallScope = { toolCallId };
  let mutationDetails: TDetails | undefined;
  let failure: ObserverFailure | undefined;
  let displayedCommand = thenRun.command;
  let commandResult: CommandResult | undefined;
  let launchTimeoutSeconds: number | undefined;
  /** A command with a timeout counts down once Bash first reports, refreshed by its heartbeat. */
  let countdown:
    | {
        readonly timeoutSeconds: number;
        readonly deadlineMs: number;
        readonly heartbeat: ReturnType<typeof setInterval>;
      }
    | undefined;

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
        failure ??= { error };
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

  async function runCommand(signal: AbortSignal, ctx: ExtensionToolContext): Promise<CommandFacts> {
    // Use the session's Bash, including overrides and both tool hooks. Pi forwards the parent signal.
    try {
      const { result, isError, durationMs } = await bashCallScope.run(bashCall, () =>
        ctx.executeTool("bash", thenRun, { onUpdate: followCommand }),
      );
      const command = {
        terminate: result.terminate,
        result: { content: result.content, details: result.details },
      };
      if (!isError) return { status: "succeeded", ...command };

      const structured = result.structuredContent;
      const hasExitCode =
        structured !== null &&
        typeof structured === "object" &&
        "exit_code" in structured &&
        typeof structured.exit_code === "number";
      const executed = durationMs !== undefined;
      let timedOut = false;
      // Pi returns a duration only for executed calls. A denial can mimic the timeout text.
      if (executed && !hasExitCode) {
        // A silent override leaves only the shared hook input to read at completion.
        const timeout = launchTimeoutSeconds ?? bashTimeoutSeconds(bashCall.input?.timeout);
        if (timeout !== undefined) {
          const diagnostic = `Command timed out after ${timeout} seconds`;
          const output = contentText(result.content);
          timedOut = output === diagnostic || output.endsWith(`\n${diagnostic}`);
        }
      }
      // An exit or a timeout wins over cancellation arriving during a result hook.
      if (signal.aborted && !hasExitCode && !timedOut)
        return executed
          ? { status: "cancelled", ...command }
          : { status: "cancelled", terminate: result.terminate };
      return { status: timedOut ? "timeout" : "failed", ...command };
    } finally {
      delete bashCall.input;
      if (countdown) clearInterval(countdown.heartbeat);
    }
  }

  return {
    report,
    runCommand,
    failure: () => failure,
    mutationCompleted(details: TDetails) {
      mutationDetails = details;
    },
    commandSettled(result: CommandResult | undefined) {
      commandResult = result;
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
  }) => {
    // Without a command, the mutation still waits for a fused call on the same file.
    if (thenRun === undefined)
      return withQueue(absolutePath, signal, async () => ({
        kind: "alone" as const,
        outcome: await mutate(),
      }));

    const progress = createBashCallCoordinator({ toolCallId, thenRun, onProgress, onUpdate });
    /** A mutation that did not complete keeps its own failure; Fusion adds only the command status. */
    const notRun = (error: unknown, command: "skipped" | "cancelled") => {
      progress.report(command, "unknown");
      return new CommandNotRun(error, command, progress.failure());
    };
    progress.report("waiting", "unknown");
    return withQueue(absolutePath, signal, async () => {
      const outcome = await mutate().catch((error: unknown) => {
        throw notRun(error, "skipped");
      });
      progress.mutationCompleted(outcome.details);

      const { publishedRevision } = outcome.commit;
      progress.report("waiting", "unknown");
      const settle = (observation: FreshnessObservation, command: CommandFacts) => {
        progress.report(command.status, observation.freshness);
        return {
          kind: "fused" as const,
          outcome,
          observation,
          command,
          progressFailure: progress.failure(),
        };
      };

      // A completed mutation remains successful; the command is only started on a fresh target.
      const before = await observeFreshness(absolutePath, publishedRevision, true);
      if (signal.aborted) return settle(before, { status: "cancelled" });
      if (before.freshness !== "unchanged") return settle(before, { status: "skipped" });

      progress.report("running", "unchanged");
      const scope = { active: true };
      let command: CommandFacts;
      try {
        command = await commandScope.run(scope, () => progress.runCommand(signal, ctx));
      } catch (error) {
        command = {
          status: signal.aborted ? "cancelled" : "failed",
          result: { content: [{ type: "text", text: errorMessage(error) }] },
        };
      } finally {
        scope.active = false;
      }
      progress.commandSettled(command.result);
      return settle(await observeFreshness(absolutePath, publishedRevision), command);
    }).catch((error: unknown) => {
      if (error instanceof CommandNotRun) throw error;
      const cancelled = error instanceof HashlineError && error.errorCode === "OPERATION_ABORTED";
      throw notRun(error, cancelled ? "cancelled" : "skipped");
    });
  };
  return schedule;
}
