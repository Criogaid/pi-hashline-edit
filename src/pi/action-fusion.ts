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
 * Writers outside these queues are not blocked; the freshness check against
 * `publishedRevision` detects them and the command is skipped or reported stale.
 * A failed command never rolls back the published file.
 *
 * @module pi-hashline-edit/pi
 */

import { realpath } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import type { AgentToolResult, AgentToolUpdateCallback } from "@earendil-works/pi-agent-core";
import type { ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import { Type, type Static, type TObject, type TProperties } from "typebox";
import { fileRevision, FileMutationError, type PublicationStatus } from "./file-commit.ts";
import { commitFreshness, finalizeMutation, type MutationOutcome } from "./mutation-result.ts";
import { errnoCode, errorMessage } from "../core/errors.ts";
import { FileChangedDuringReadError, throwIfCancelled } from "./error-text.ts";
import { AnnotatedError, unannotated } from "./tool-error.ts";

const MILLISECONDS_PER_SECOND = 1_000;

export const THEN_RUN_SUCCEEDED = "[then_run:succeeded]";
export const THEN_RUN_FAILED = "[then_run:failed]";
export const THEN_RUN_SKIPPED = "[then_run:skipped]";
export const THEN_RUN_STALE = "[then_run:stale]";
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

export type CommandStatus =
  | "not_requested"
  | "skipped"
  | "succeeded"
  | "failed"
  | "timeout"
  | "cancelled";
export type Freshness = "unchanged" | "changed" | "missing" | "unknown";
export interface ActionFusionDetails {
  publication: PublicationStatus;
  command: CommandStatus;
  freshness: Freshness;
}

export interface ActionFusionProgress extends Omit<ActionFusionDetails, "command"> {
  toolCallId: string;
  path: string;
  commandText: string;
  command: Exclude<CommandStatus, "not_requested"> | "waiting" | "running";
  /** Command output or command execution errors only. */
  output: string;
  /** A short explanation when the command was not started; never mutation diagnostics. */
  reason?: string;
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
  readonly status: Exclude<CommandStatus, "not_requested" | "skipped">;
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

type MutationResult<TDetails> = AgentToolResult<TDetails>;
/** Attach the fused outcome to a finalized mutation result, plus optional command text. */
function withFusionDetails<TDetails>(
  result: MutationResult<TDetails>,
  actionFusion: ActionFusionDetails,
  commandText?: string,
): MutationResult<TDetails> {
  return {
    ...result,
    details: { ...((result.details as object) ?? {}), actionFusion },
    content:
      commandText === undefined
        ? result.content
        : [...result.content, { type: "text", text: commandText }],
  } as MutationResult<TDetails>;
}

/** A failed revision read: a concurrent write or a deletion is itself an observation. */
function freshnessOfFailedRead(error: unknown): Freshness {
  // A write observed during the read has already moved the target off the published revision.
  if (error instanceof FileChangedDuringReadError) return "changed";
  return errnoCode(error) === "ENOENT" ? "missing" : "unknown";
}

async function readFreshness(path: string, baseline: string): Promise<Freshness> {
  try {
    return (await fileRevision(path)) === baseline ? "unchanged" : "changed";
  } catch (error) {
    return freshnessOfFailedRead(error);
  }
}

const COMMAND_CANCELLED = "Not run because the operation was cancelled.";
/** Shown on the command card only: the result's stale notice already tells the model. */
const TARGET_CHANGED = "Not run because the target changed after the mutation.";

/**
 * The target's freshness before the command starts and, unless it is still the
 * published revision, why the command must not start. Two reads across a turn
 * of the event loop catch a write in progress.
 */
async function observeBeforeCommand(
  path: string,
  baseline: string,
): Promise<{ freshness: Freshness; blocker?: string }> {
  try {
    const before = await fileRevision(path);
    await new Promise<void>((resolve) => setImmediate(resolve));
    const after = await fileRevision(path);
    return before === baseline && after === baseline
      ? { freshness: "unchanged" }
      : { freshness: "changed", blocker: TARGET_CHANGED };
  } catch (error) {
    // The mutation is already published; a concurrent change must not suggest retrying it.
    const freshness = freshnessOfFailedRead(error);
    return {
      freshness,
      blocker:
        freshness === "changed"
          ? TARGET_CHANGED
          : `Target revision could not be read: ${errorMessage(error)}`,
    };
  }
}

/**
 * The command's own outcome block after a completed mutation: the then_run tag,
 * the reason it did not run or finish, then its output. The mutation summary
 * above it owns the file state.
 */
function commandOutcomeText(
  command: Exclude<CommandStatus, "not_requested">,
  output: string,
  reason?: string,
): string {
  const tag =
    command === "succeeded"
      ? THEN_RUN_SUCCEEDED
      : command === "skipped" || command === "cancelled"
        ? THEN_RUN_SKIPPED
        : THEN_RUN_FAILED;
  const why = reason ?? (command === "cancelled" ? "Cancelled while running." : undefined);
  return [why ? `${tag} ${why}` : tag, output].filter(Boolean).join("\n");
}

/** Publication of a mutation failure, for progress reports; the error record states it to the model. */
function publicationOf(error: unknown): PublicationStatus {
  const failure = unannotated(error);
  return failure instanceof FileMutationError ? failure.publication : "NOT_PUBLISHED";
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

  return async function execute<TDetails>({
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
    mutate: () => Promise<MutationOutcome<TDetails>>;
    signal: AbortSignal | undefined;
    ctx: ExtensionToolContext;
    onUpdate?: AgentToolUpdateCallback<TDetails>;
  }): Promise<MutationResult<TDetails>> {
    let completedMutation: MutationOutcome<TDetails> | undefined;
    let commandTermination: boolean | undefined;
    let progressFailure: string | undefined;
    let commandTiming: { readonly timeoutSeconds: number; readonly deadlineMs: number } | undefined;
    const report = (
      command: ActionFusionProgress["command"],
      publication: PublicationStatus,
      freshness: Freshness,
      output = "",
      reason?: string,
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
        ...(reason ? { reason } : {}),
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
            content: [
              ...(completedMutation?.result.content ?? []),
              {
                type: "text",
                text: `then_run ${command}: ${thenRun.command}\n${reason ?? output}`,
              },
            ],
            details: {
              ...((completedMutation?.result.details as object) ?? {}),
              actionFusion: progress,
            },
          } as MutationResult<TDetails>),
      ]) {
        try {
          notify();
        } catch (error) {
          progressFailure ??= errorMessage(error);
        }
      }
    };
    /** A mutation that did not complete keeps its own record; then_run states the command was not run. */
    const notRun = (error: unknown, command: "skipped" | "cancelled", reason: string) => {
      report(command, publicationOf(error), "unknown", "", reason);
      return new AnnotatedError(error, {
        then_run: command,
        ...(progressFailure ? { progressReportingFailed: progressFailure } : {}),
      });
    };
    report("waiting", "NOT_PUBLISHED", "unknown");
    return withQueue(absolutePath, async () => {
      try {
        throwIfCancelled(signal);
      } catch (error) {
        if (thenRun !== undefined)
          throw notRun(error, "cancelled", "Not run because the mutation was cancelled.");
        throw error;
      }
      let outcome: MutationOutcome<TDetails>;
      try {
        outcome = await mutate();
        completedMutation = outcome;
      } catch (error) {
        if (thenRun !== undefined)
          throw notRun(error, "skipped", "Not run because the mutation did not complete.");
        throw error;
      }

      const { publication, publishedRevision: baseline } = outcome.commit;
      report("waiting", publication, "unknown");
      if (thenRun === undefined) {
        const freshness = commitFreshness(outcome.commit);
        return withFusionDetails(finalizeMutation(outcome, freshness === "unchanged"), {
          publication,
          command: "not_requested",
          freshness,
        });
      }
      // A completed mutation remains successful; the command outcome is its own block.
      const settle = (
        command: Exclude<CommandStatus, "not_requested">,
        freshness: Freshness,
        output: string,
        reason?: string,
      ) => {
        report(command, publication, freshness, output, reason);
        return withFusionDetails(
          finalizeMutation(outcome, freshness === "unchanged", THEN_RUN_STALE),
          { publication, command, freshness },
          // The stale notice above the command block already states a changed target.
          commandOutcomeText(command, output, reason === TARGET_CHANGED ? undefined : reason),
        );
      };
      const observed = await observeBeforeCommand(absolutePath, baseline);
      if (signal?.aborted) return settle("cancelled", observed.freshness, "", COMMAND_CANCELLED);
      if (observed.blocker !== undefined)
        return settle("skipped", observed.freshness, "", observed.blocker);

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
      commandTermination = command.terminate;
      return settle(command.status, await readFreshness(absolutePath, baseline), output);
    })
      .catch((error: unknown) => {
        // Failures before the mutation started (such as resolving the queue key) also skip the command.
        if (thenRun === undefined || error instanceof AnnotatedError) throw error;
        throw notRun(error, "skipped", "Not run because the mutation did not complete.");
      })
      .then((result) => {
        const finalResult =
          commandTermination === undefined ? result : { ...result, terminate: commandTermination };
        return progressFailure
          ? {
              ...finalResult,
              content: [
                ...finalResult.content,
                { type: "text" as const, text: `Progress reporting failed: ${progressFailure}` },
              ],
            }
          : finalResult;
      });
  };
}
