/**
 * Action Fusion: run an optional `then_run` command after a successful mutation.
 *
 * Two per-file queues nest here, with different jobs:
 * - Pi's `withFileMutationQueue` (entered by the mutation runner) serializes
 *   the read-modify-write itself and is shared with every tool that uses it.
 *   It is released as soon as the file is published.
 * - The executor's own queue wraps mutation, freshness check, and command, so
 *   a later fused call on the same file waits until this command finishes and
 *   cannot change the revision the command started from. Its key resolves the nearest
 *   existing ancestor and folds case on Windows, so it is never looser than
 *   Pi's key. It is always taken first and Pi's queue never waits on it, so
 *   the nesting cannot deadlock.
 *
 * Writers outside these queues are not blocked; the commit layer's freshness
 * observation against `publishedRevision` detects them, and the command is
 * skipped or the result reports the changed freshness. A failed command never
 * rolls back the published file. Fusion states only the command: its status,
 * output, and termination request; the file state belongs to the mutation result.
 *
 * @module pi-hashline-edit/pi
 */

import { realpath } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import type { AgentToolUpdateCallback } from "@earendil-works/pi-agent-core";
import type { ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import { Type, type Static, type TObject, type TProperties } from "typebox";
import { commitFreshness, observeFreshness, type FreshnessObservation } from "./file-commit.ts";
import {
  CommandNotRun,
  commandText,
  type CommandFacts,
  type MutationOutcome,
  type MutationResultDetails,
} from "./mutation-result.ts";
import { errnoCode, errorMessage } from "../core/errors.ts";
import { throwIfCancelled } from "./error-text.ts";
import type {
  ActionFusionProgress,
  CommandResult,
  CommandStatus,
  Freshness,
  MutationToolName,
} from "./report-schema.ts";

const MILLISECONDS_PER_SECOND = 1_000;

// Pi's built-in Bash rejects timeouts above the setTimeout millisecond limit.
const MAX_BASH_TIMEOUT_SECONDS = 2_147_483_647 / 1_000;

// Pi's Bash runs on this host, and Pi's prompt does not name the OS; only Windows needs the path note.
const COMMAND_DESCRIPTION =
  process.platform === "win32"
    ? "Bash command to run. This host is Windows: avoid Unix-only paths such as /tmp."
    : "Bash command to run.";

export const ACTION_FUSION_GUIDELINES = [
  "When a check covers several changes, run it once after all of those changes.",
];

type ProgressReporter = (progress: ActionFusionProgress) => void;

function createThenRunSchema(tool: MutationToolName) {
  return Type.Optional(
    Type.Object(
      {
        command: Type.String({ minLength: 1, pattern: "\\S", description: COMMAND_DESCRIPTION }),
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

/** Name then_run in a mutation tool's description when Action Fusion is enabled. */
export function withThenRunDescription(description: string, actionFusion: boolean): string {
  return actionFusion
    ? `${description} Set the then_run parameter for checks that can run immediately after this change. Use a separate bash call when the command requires approval, needs information from this tool's result, must wait for reload, or checks several changes from one response.`
    : description;
}

/** What a fused call leaves for the mutation runner to report; Fusion builds no result itself. */
export interface FusedMutation<TDetails, TTool extends MutationToolName> {
  readonly outcome: MutationOutcome<TDetails, TTool>;
  readonly observation: FreshnessObservation;
  /** Absent when the call has no then_run. */
  readonly command?: CommandFacts;
  /** Preserve the session tool's request to stop after this tool batch. */
  readonly terminate?: boolean;
}

/** Keep command state independent of its diagnostic text and of file publication. */
interface CommandOutcome {
  readonly status: Exclude<CommandStatus, "skipped">;
  readonly result: CommandResult;
  /** Preserve the session tool's request to stop after this tool batch. */
  readonly terminate?: boolean;
}

type CommandRunner = (
  toolCallId: string,
  input: ThenRunInput,
  signal: AbortSignal | undefined,
  ctx: ExtensionToolContext,
  onUpdate?: AgentToolUpdateCallback<unknown>,
) => Promise<CommandOutcome>;

async function defaultCommandRunner(
  _toolCallId: string,
  input: ThenRunInput,
  signal: AbortSignal | undefined,
  ctx: ExtensionToolContext,
  onUpdate?: AgentToolUpdateCallback<unknown>,
): Promise<CommandOutcome> {
  // Use the session's callable Bash, including overrides, validation, permission
  // hooks and tool_result hooks. Tool failures resolve with isError, not rejection.
  const { result, isError } = await ctx.executeTool("bash", input, { signal, onUpdate });
  const command = {
    terminate: result.terminate,
    result: { content: result.content, details: result.details },
  };
  if (!isError) return { status: "succeeded", ...command };
  if (signal?.aborted) return { status: "cancelled", ...command };

  const structured = result.structuredContent;
  const hasExitCode =
    structured !== null &&
    typeof structured === "object" &&
    "exit_code" in structured &&
    typeof structured.exit_code === "number";
  // Pi 0.99.1 supplies exit_code for ordinary exits, but serializes a thrown
  // timeout as text. Only recognize its final diagnostic for the requested
  // timeout; a failed command's output may itself mention or quote a timeout.
  const timeoutDiagnostic = `Command timed out after ${input.timeout} seconds`;
  const output = commandText(result.content);
  const timedOut =
    !hasExitCode &&
    input.timeout !== undefined &&
    (output === timeoutDiagnostic || output.endsWith(`\n${timeoutDiagnostic}`));
  return { status: timedOut ? "timeout" : "failed", ...command };
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

/**
 * One then_run call's display state and the observers that follow it. Display callbacks are
 * observers: their failures must not change publication or command execution, so the first is
 * kept for the report. The tracker owns the heartbeat lifetime; Pi Bash owns timeout and
 * process cleanup.
 */
function createProgressTracker<TDetails extends object>({
  toolCallId,
  thenRun,
  onProgress,
  onUpdate,
}: {
  toolCallId: string;
  thenRun: ThenRunInput;
  onProgress: ProgressReporter | undefined;
  onUpdate: AgentToolUpdateCallback<MutationResultDetails<TDetails>> | undefined;
}) {
  let mutationDetails: TDetails | undefined;
  let failure: unknown;
  let commandResult: CommandResult | undefined;
  let commandTiming: { readonly timeoutSeconds: number; readonly deadlineMs: number } | undefined;
  let heartbeat: ReturnType<typeof setInterval> | undefined;

  const report = (command: ActionFusionProgress["command"], freshness: Freshness) => {
    const progress: ActionFusionProgress = {
      toolCallId,
      commandText: thenRun.command,
      command,
      freshness,
      ...(commandResult ? { result: commandResult } : {}),
      mutationCompleted: mutationDetails !== undefined,
      ...(commandTiming
        ? {
            timing: {
              timeoutSeconds: commandTiming.timeoutSeconds,
              remainingSeconds: Math.max(
                0,
                Math.ceil((commandTiming.deadlineMs - Date.now()) / MILLISECONDS_PER_SECOND),
              ),
            },
          }
        : {}),
    };
    for (const notify of [
      () => onProgress?.(progress),
      () => onUpdate?.({ content: [], details: { ...mutationDetails, actionFusion: progress } }),
    ]) {
      try {
        notify();
      } catch (error) {
        failure ??= error;
      }
    }
  };

  /** Follow the running command's partial results. */
  const followCommand: AgentToolUpdateCallback<unknown> = (partial) => {
    // Pi Bash emits an initial update even for silent commands. Start its
    // countdown here, after session permission hooks have allowed execution.
    if (!commandTiming && thenRun.timeout !== undefined) {
      commandTiming = {
        timeoutSeconds: thenRun.timeout,
        deadlineMs: Date.now() + thenRun.timeout * MILLISECONDS_PER_SECOND,
      };
      if (onProgress || onUpdate) {
        heartbeat = setInterval(() => report("running", "unknown"), MILLISECONDS_PER_SECOND);
        heartbeat.unref();
      }
    }
    commandResult = { content: partial.content, details: partial.details };
    report("running", "unknown");
  };

  return {
    report,
    followCommand,
    failure: () => failure,
    mutationCompleted(details: TDetails) {
      mutationDetails = details;
    },
    stopHeartbeat() {
      if (heartbeat) clearInterval(heartbeat);
    },
    commandSettled(result: CommandResult) {
      commandResult = result;
    },
  };
}

export function createActionFusionExecutor(
  commandRunner: CommandRunner = defaultCommandRunner,
  onProgress?: ProgressReporter,
) {
  const queueTails = new Map<string, Promise<void>>();

  async function withQueue<T>(path: string, work: () => Promise<T>): Promise<T> {
    const key = await canonicalQueueKey(path);
    const previous = queueTails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const owned = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => owned);
    queueTails.set(key, tail);
    await previous;
    try {
      return await work();
    } finally {
      release();
      if (queueTails.get(key) === tail) queueTails.delete(key);
    }
  }

  return async function execute<TDetails extends object, TTool extends MutationToolName>({
    toolCallId,
    absolutePath,
    thenRun,
    mutate,
    signal,
    ctx,
    onUpdate,
  }: {
    toolCallId: string;
    absolutePath: string;
    thenRun: ThenRunInput | undefined;
    mutate: () => Promise<MutationOutcome<TDetails, TTool>>;
    signal: AbortSignal | undefined;
    ctx: ExtensionToolContext;
    onUpdate?: AgentToolUpdateCallback<MutationResultDetails<TDetails>>;
  }): Promise<FusedMutation<TDetails, TTool>> {
    // Without a command, the mutation still waits for a fused call on the same file.
    if (thenRun === undefined) {
      return withQueue(absolutePath, async () => {
        throwIfCancelled(signal);
        const outcome = await mutate();
        return { outcome, observation: commitFreshness(outcome.commit) };
      });
    }

    const progress = createProgressTracker<TDetails>({
      toolCallId,
      thenRun,
      onProgress,
      onUpdate,
    });
    /** A mutation that did not complete keeps its own failure; Fusion adds only the command status. */
    const notRun = (error: unknown, command: "skipped" | "cancelled") => {
      progress.report(command, "unknown");
      return new CommandNotRun(error, command, progress.failure());
    };
    progress.report("waiting", "unknown");
    return withQueue(absolutePath, async () => {
      try {
        throwIfCancelled(signal);
      } catch (error) {
        throw notRun(error, "cancelled");
      }
      let outcome: MutationOutcome<TDetails, TTool>;
      try {
        outcome = await mutate();
        progress.mutationCompleted(outcome.details);
      } catch (error) {
        throw notRun(error, "skipped");
      }

      const { publishedRevision } = outcome.commit;
      progress.report("waiting", "unknown");
      const settle = (observation: FreshnessObservation, command: CommandFacts) => {
        progress.report(command.status, observation.freshness);
        return {
          outcome,
          observation,
          command: { ...command, progressError: progress.failure() },
        };
      };

      // A completed mutation remains successful; the command is only started on a fresh target.
      const before = await observeFreshness(absolutePath, publishedRevision, true);
      if (signal?.aborted) return settle(before, { status: "cancelled" });
      if (before.freshness !== "unchanged") return settle(before, { status: "skipped" });

      progress.report("running", "unchanged");
      let command: CommandOutcome;
      try {
        command = await commandRunner(toolCallId, thenRun, signal, ctx, progress.followCommand);
      } catch (error) {
        command = {
          status: signal?.aborted ? "cancelled" : "failed",
          result: { content: [{ type: "text", text: errorMessage(error) }] },
        };
      } finally {
        progress.stopHeartbeat();
      }
      progress.commandSettled(command.result);
      const settled = settle(await observeFreshness(absolutePath, publishedRevision), {
        status: command.status,
        result: command.result,
      });
      return command.terminate === undefined
        ? settled
        : { ...settled, terminate: command.terminate };
    }).catch((error: unknown) => {
      // Failures before the mutation started (such as resolving the queue key) also skip the command.
      if (error instanceof CommandNotRun) throw error;
      throw notRun(error, "skipped");
    });
  };
}
