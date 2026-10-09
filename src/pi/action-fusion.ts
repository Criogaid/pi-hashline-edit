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
import type { AgentToolResult, AgentToolUpdateCallback } from "@earendil-works/pi-agent-core";
import type { ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import { Type, type Static, type TObject, type TProperties } from "typebox";
import {
  commitFreshness,
  FileMutationError,
  observeFreshness,
  type FreshnessObservation,
} from "./file-commit.ts";
import { finalizeMutation, type CommandFacts, type MutationOutcome } from "./mutation-result.ts";
import { errorMessage } from "../core/errors.ts";
import { throwIfCancelled } from "./error-text.ts";
import { causeOf, CommandNotRun, type ReportDetails } from "./report.ts";
import type { CommandStatus, Freshness, PublicationStatus } from "./report-schema.ts";

const MILLISECONDS_PER_SECOND = 1_000;

// Pi's built-in Bash rejects timeouts above the setTimeout millisecond limit.
const MAX_BASH_TIMEOUT_SECONDS = 2_147_483_647 / 1_000;

export const ACTION_FUSION_GUIDELINES = [
  "Before each file mutation, identify its next command.",
  "Prefer then_run when the next command is known, authorized, and ready after the mutation succeeds.",
  "When several edits are prerequisites, attach then_run to the last one.",
  "Run the command separately if it depends on the mutation result, needs approval, or awaits a reload.",
  "Use platform-appropriate commands; avoid Unix-only paths like /tmp on Windows.",
  "Check the command outcome before claiming validation passed.",
];

export interface ActionFusionDetails {
  publication: PublicationStatus;
  command: CommandStatus | "not_requested";
  freshness: Freshness;
}

export interface ActionFusionProgress extends Omit<ActionFusionDetails, "command"> {
  toolCallId: string;
  path: string;
  commandText: string;
  command: CommandStatus | "waiting" | "running";
  /** Command output or command execution errors only. */
  output: string;
  /** True only after mutation execution and result generation both succeed. */
  mutationCompleted: boolean;
  /** Present once a command with an explicit timeout starts; refreshed during silent execution. */
  timing?: { readonly timeoutSeconds: number; readonly remainingSeconds: number };
}

type ProgressReporter = (progress: ActionFusionProgress, ctx: ExtensionToolContext) => void;

/** The tools that accept then_run. */
export type MutationToolName = "edit" | "replace" | "write";

export function createThenRunSchema(tool: MutationToolName) {
  return Type.Optional(
    Type.Object(
      {
        command: Type.String({ minLength: 1, pattern: "\\S", description: "Bash command to run" }),
        timeout: Type.Optional(
          Type.Number({
            exclusiveMinimum: 0,
            maximum: MAX_BASH_TIMEOUT_SECONDS,
            description: "Timeout in seconds (optional, no default timeout)",
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

/** Keep command state independent of its diagnostic text and of file publication. */
export interface CommandOutcome {
  readonly status: Exclude<CommandStatus, "skipped">;
  readonly output: string;
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

/** Publication of a mutation failure, for progress reports; the failure report states it to the model. */
function publicationOf(error: unknown): PublicationStatus {
  return error instanceof FileMutationError ? error.publication : "NOT_PUBLISHED";
}

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
  const output = result.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n");
  const command = { output, terminate: result.terminate };
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
  const timedOut =
    !hasExitCode &&
    input.timeout !== undefined &&
    (output === timeoutDiagnostic || output.endsWith(`\n${timeoutDiagnostic}`));
  return { status: timedOut ? "timeout" : "failed", ...command };
}

async function canonicalQueueKey(path: string): Promise<string> {
  const resolved = resolve(path);
  let current = resolved;
  const missing: string[] = [];
  while (true) {
    try {
      const canonical = resolve(await realpath(current), ...missing);
      return process.platform === "win32" ? canonical.toLowerCase() : canonical;
    } catch (error) {
      if (
        !(
          typeof error === "object" &&
          error !== null &&
          "code" in error &&
          (error.code === "ENOENT" || error.code === "ENOTDIR")
        )
      )
        throw error;
      const parent = dirname(current);
      if (parent === current)
        return process.platform === "win32" ? resolved.toLowerCase() : resolved;
      missing.unshift(basename(current));
      current = parent;
    }
  }
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

  return async function execute<TDetails extends object>({
    toolCallId,
    tool,
    displayPath,
    absolutePath,
    thenRun,
    mutate,
    signal,
    ctx,
    onUpdate,
  }: {
    toolCallId: string;
    tool: MutationToolName;
    /** The caller-supplied path, as the report states it. */
    displayPath: string;
    absolutePath: string;
    thenRun: ThenRunInput | undefined;
    mutate: () => Promise<MutationOutcome<TDetails>>;
    signal: AbortSignal | undefined;
    ctx: ExtensionToolContext;
    onUpdate?: AgentToolUpdateCallback<TDetails>;
  }): Promise<AgentToolResult<TDetails & ReportDetails>> {
    let completedMutation: MutationOutcome<TDetails> | undefined;
    let progressFailure: unknown;
    let commandTiming: { readonly timeoutSeconds: number; readonly deadlineMs: number } | undefined;
    const report = (
      command: ActionFusionProgress["command"],
      publication: PublicationStatus,
      freshness: Freshness,
      output = "",
    ) => {
      if (!thenRun) return;
      const progress: ActionFusionProgress = {
        toolCallId,
        path: absolutePath,
        commandText: thenRun.command,
        command,
        publication,
        freshness,
        output,
        mutationCompleted: completedMutation !== undefined,
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
      // Display callbacks are observers: their failures must not change publication or command execution.
      for (const notify of [
        () => onProgress?.(progress, ctx),
        () =>
          onUpdate?.({
            content: [],
            details: { ...completedMutation?.details, actionFusion: progress },
          } as unknown as AgentToolResult<TDetails>),
      ]) {
        try {
          notify();
        } catch (error) {
          progressFailure ??= error;
        }
      }
    };
    /** A mutation that did not complete keeps its own failure; Fusion adds only the command status. */
    const notRun = (error: unknown, command: "skipped" | "cancelled") => {
      report(command, publicationOf(error), "unknown");
      return new CommandNotRun(error, command, causeOf(progressFailure));
    };
    report("waiting", "NOT_PUBLISHED", "unknown");
    let terminate: boolean | undefined;
    const result = await withQueue(absolutePath, async () => {
      try {
        throwIfCancelled(signal);
      } catch (error) {
        if (thenRun !== undefined) throw notRun(error, "cancelled");
        throw error;
      }
      let outcome: MutationOutcome<TDetails>;
      try {
        outcome = await mutate();
        completedMutation = outcome;
      } catch (error) {
        if (thenRun !== undefined) throw notRun(error, "skipped");
        throw error;
      }

      const { publication, publishedRevision } = outcome.commit;
      report("waiting", publication, "unknown");
      const settle = (observation: FreshnessObservation, command?: CommandFacts) => {
        if (command) report(command.status, publication, observation.freshness, command.output);
        const settled = finalizeMutation(
          tool,
          displayPath,
          outcome,
          observation,
          command && { ...command, progressError: progressFailure },
        );
        const actionFusion: ActionFusionDetails = {
          publication,
          command: command?.status ?? "not_requested",
          freshness: observation.freshness,
        };
        return { ...settled, details: { ...settled.details, actionFusion } };
      };
      if (thenRun === undefined) return settle(commitFreshness(outcome.commit));

      // A completed mutation remains successful; the command is only started on a fresh target.
      const before = await observeFreshness(absolutePath, publishedRevision, true);
      if (signal?.aborted) return settle(before, { status: "cancelled" });
      if (before.freshness !== "unchanged") return settle(before, { status: "skipped" });

      report("running", publication, "unchanged");
      let output = "";
      let command: CommandOutcome;
      // The executor owns the heartbeat lifetime; Pi Bash owns timeout and process cleanup.
      let heartbeat: ReturnType<typeof setInterval> | undefined;
      try {
        command = await commandRunner(toolCallId, thenRun, signal, ctx, (partial) => {
          // Pi Bash emits an initial update even for silent commands. Start its
          // countdown here, after session permission hooks have allowed execution.
          if (!commandTiming && thenRun.timeout !== undefined) {
            commandTiming = {
              timeoutSeconds: thenRun.timeout,
              deadlineMs: Date.now() + thenRun.timeout * MILLISECONDS_PER_SECOND,
            };
            if (onProgress || onUpdate) {
              heartbeat = setInterval(
                () => report("running", publication, "unknown", output),
                MILLISECONDS_PER_SECOND,
              );
              heartbeat.unref();
            }
          }
          output = partial.content
            .filter((block) => block.type === "text")
            .map((block) => block.text)
            .join("\n");
          report("running", publication, "unknown", output);
        });
        output = command.output;
      } catch (error) {
        output = errorMessage(error);
        command = { status: signal?.aborted ? "cancelled" : "failed", output };
      } finally {
        if (heartbeat) clearInterval(heartbeat);
      }
      terminate = command.terminate;
      return settle(await observeFreshness(absolutePath, publishedRevision), {
        status: command.status,
        output,
      });
    }).catch((error: unknown) => {
      // Failures before the mutation started (such as resolving the queue key) also skip the command.
      if (thenRun === undefined || error instanceof CommandNotRun) throw error;
      throw notRun(error, "skipped");
    });
    return terminate === undefined ? result : { ...result, terminate };
  };
}
