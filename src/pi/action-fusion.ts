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
import { createBashToolDefinition, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type, type Static, type TObject, type TProperties } from "typebox";
import { fileRevision, FileMutationError, type PublicationStatus } from "./file-commit.ts";
import { commitFreshness, finalizeMutation, type MutationOutcome } from "./mutation-result.ts";
import type { MutationToolName } from "./mutation-runner.ts";
import { errorMessage } from "../core/errors.ts";
import { OPERATION_ABORTED, throwIfCancelled } from "./error-text.ts";

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

type ProgressReporter = (progress: ActionFusionProgress, ctx: ExtensionContext) => void;

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
        description: `Command to run once after ${tool} succeeds; failure does not roll back its changes.`,
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

type CommandRunner = (
  toolCallId: string,
  input: ThenRunInput,
  signal: AbortSignal | undefined,
  ctx: ExtensionContext,
  onUpdate?: AgentToolUpdateCallback<unknown>,
) => Promise<string>;

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

async function readFreshness(path: string, baseline: string): Promise<Freshness> {
  try {
    return (await fileRevision(path)) === baseline ? "unchanged" : "changed";
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT")
      return "missing";
    return "unknown";
  }
}

async function assertUnchangedBeforeCommand(path: string, baseline: string): Promise<void> {
  try {
    const before = await fileRevision(path);
    await new Promise<void>((resolve) => setImmediate(resolve));
    const after = await fileRevision(path);
    if (before !== baseline || after !== baseline) {
      throw new Error("target content changed after the fused mutation");
    }
  } catch (error) {
    throw new Error(`${THEN_RUN_SKIPPED} ${errorMessage(error)}; the command was not run.`);
  }
}

export class ActionFusionError extends Error {
  readonly publication: PublicationStatus;
  readonly command: CommandStatus;
  readonly freshness: Freshness;
  readonly commandOutput: string;
  readonly commandReason: string | undefined;

  constructor(
    message: string,
    state: { publication: PublicationStatus; command: CommandStatus; freshness: Freshness },
    options?: {
      cause?: unknown;
      mutationFailure?: boolean;
      commandOutput?: string;
      commandReason?: string;
      rawMessage?: boolean;
    },
  ) {
    if (options?.rawMessage) {
      super(message, options);
    } else {
      const fileState =
        state.publication === "PUBLISHED"
          ? "File changes are saved."
          : state.publication === "NOT_PUBLISHED"
            ? "No file changes were published."
            : "File state is uncertain.";
      const outcome = `${message} ${state.command === "skipped" || state.command === "cancelled" ? THEN_RUN_SKIPPED : state.command === "succeeded" ? THEN_RUN_SUCCEEDED : THEN_RUN_FAILED}\n${fileState} Command ${state.command}.`;
      const diagnostic = options?.cause === undefined ? "" : errorMessage(options.cause);
      // Pi serializes only the message. Put the mutation's own error first for its card.
      super(
        (options?.mutationFailure ? [diagnostic, outcome] : [outcome, diagnostic])
          .filter(Boolean)
          .join("\n"),
        options,
      );
    }
    this.commandOutput = options?.commandOutput ?? "";
    this.commandReason = options?.commandReason;
    this.name = "ActionFusionError";
    this.publication = state.publication;
    this.command = state.command;
    this.freshness = state.freshness;
  }
}

function commandStatus(error: unknown, signal: AbortSignal | undefined): CommandStatus {
  if (signal?.aborted) return "cancelled";
  return /timeout|timed out/i.test(errorMessage(error)) ? "timeout" : "failed";
}

async function defaultCommandRunner(
  toolCallId: string,
  input: ThenRunInput,
  signal: AbortSignal | undefined,
  ctx: ExtensionContext,
  onUpdate?: AgentToolUpdateCallback<unknown>,
): Promise<string> {
  const bash = createBashToolDefinition(ctx.cwd);
  const result = await bash.execute(`${toolCallId}:then_run`, input, signal, onUpdate, ctx);
  return result.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n");
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
    ctx: ExtensionContext;
    onUpdate?: AgentToolUpdateCallback<TDetails>;
  }): Promise<MutationResult<TDetails>> {
    let completedMutation: MutationOutcome<TDetails> | undefined;
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
    report("waiting", "NOT_PUBLISHED", "unknown");
    return withQueue(absolutePath, async () => {
      try {
        throwIfCancelled(signal);
      } catch (error) {
        if (thenRun !== undefined)
          throw new ActionFusionError(
            `${OPERATION_ABORTED} before the mutation started; the command was not run`,
            { publication: "NOT_PUBLISHED", command: "cancelled", freshness: "unknown" },
            {
              cause: error,
              mutationFailure: true,
              commandReason: "Not run because the mutation was cancelled.",
            },
          );
        throw error;
      }
      let outcome: MutationOutcome<TDetails>;
      try {
        outcome = await mutate();
        completedMutation = outcome;
      } catch (error) {
        const publication =
          error instanceof FileMutationError ? error.publication : "NOT_PUBLISHED";
        if (thenRun !== undefined) {
          throw new ActionFusionError(
            `mutation ${error instanceof FileMutationError ? error.stage : "failed"}; the command was not run`,
            { publication, command: "skipped", freshness: "unknown" },
            {
              cause: error,
              mutationFailure: true,
              commandReason: "Not run because the mutation did not complete.",
            },
          );
        }
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
      try {
        throwIfCancelled(signal);
        await assertUnchangedBeforeCommand(absolutePath, baseline);
        throwIfCancelled(signal);
      } catch (error) {
        const freshness = await readFreshness(absolutePath, baseline);
        throw new ActionFusionError(
          "mutation completed; the command was not run",
          { publication, command: signal?.aborted ? "cancelled" : "skipped", freshness },
          {
            cause: error,
            commandReason: signal?.aborted
              ? "Not run because the operation was cancelled."
              : "Not run because the target revision could not be confirmed.",
          },
        );
      }

      if (thenRun.timeout !== undefined) {
        commandTiming = {
          timeoutSeconds: thenRun.timeout,
          deadlineMs: Date.now() + thenRun.timeout * MILLISECONDS_PER_SECOND,
        };
      }
      report("running", publication, "unchanged");
      let output = "";
      let commandError: unknown;
      // The executor owns the heartbeat lifetime; Pi Bash owns timeout and process cleanup.
      const heartbeat =
        commandTiming && (onProgress || onUpdate)
          ? setInterval(
              () => report("running", publication, "unknown", output),
              MILLISECONDS_PER_SECOND,
            )
          : undefined;
      heartbeat?.unref();
      try {
        output = await commandRunner(toolCallId, thenRun, signal, ctx, (partial) => {
          output = partial.content
            .filter((block) => block.type === "text")
            .map((block) => block.text)
            .join("\n");
          report("running", publication, "unknown", output);
        });
      } catch (error) {
        commandError = error;
        output = "";
      } finally {
        if (heartbeat) clearInterval(heartbeat);
      }
      const freshness = await readFreshness(absolutePath, baseline);
      if (commandError !== undefined) {
        throw new ActionFusionError(
          "mutation completed; then_run did not complete successfully",
          { publication, command: commandStatus(commandError, signal), freshness },
          { cause: commandError, commandOutput: errorMessage(commandError) },
        );
      }

      report("succeeded", publication, freshness, output);
      return withFusionDetails(
        finalizeMutation(outcome, freshness === "unchanged", THEN_RUN_STALE),
        { publication, command: "succeeded", freshness },
        `${THEN_RUN_SUCCEEDED}${output ? `\n${output}` : ""}`,
      );
    })
      .catch((error: unknown) => {
        report(
          error instanceof ActionFusionError
            ? (error.command as ActionFusionProgress["command"])
            : "skipped",
          error instanceof ActionFusionError || error instanceof FileMutationError
            ? error.publication
            : (completedMutation?.commit.publication ?? "NOT_PUBLISHED"),
          error instanceof ActionFusionError ? error.freshness : "unknown",
          error instanceof ActionFusionError ? error.commandOutput : "",
          error instanceof ActionFusionError
            ? error.commandReason
            : "Not run because the mutation did not complete.",
        );
        // A completed mutation remains successful; command failure belongs to its own card.
        if (completedMutation && error instanceof ActionFusionError) {
          return withFusionDetails(
            finalizeMutation(completedMutation, error.freshness === "unchanged", THEN_RUN_STALE),
            { publication: error.publication, command: error.command, freshness: error.freshness },
            error.message,
          );
        }
        {
          const parts: string[] = [errorMessage(error)];
          if (error instanceof ActionFusionError && error.publication !== "NOT_PUBLISHED")
            parts.push("Re-read before retrying.");
          if (progressFailure) parts.push(`Progress reporting failed: ${progressFailure}`);
          if (parts.length > 1 || !(error instanceof Error)) {
            const wrapped =
              error instanceof ActionFusionError
                ? new ActionFusionError(
                    parts.join("\n"),
                    {
                      publication: error.publication,
                      command: error.command,
                      freshness: error.freshness,
                    },
                    {
                      cause: error,
                      commandOutput: error.commandOutput,
                      commandReason: error.commandReason,
                      rawMessage: true,
                    },
                  )
                : new Error(parts.join("\n"), { cause: error });
            throw wrapped;
          }
          throw error;
        }
      })
      .then((result) =>
        progressFailure
          ? {
              ...result,
              content: [
                ...result.content,
                { type: "text" as const, text: `Progress reporting failed: ${progressFailure}` },
              ],
            }
          : result,
      );
  };
}
