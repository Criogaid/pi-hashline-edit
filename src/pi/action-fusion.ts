/**
 * Fusion serializes mutation plus command per canonical file. Its queue is acquired
 * before Pi's mutation queue; Pi's queue never waits for Fusion. External writers
 * remain possible and are observed by the commit owner. Commands never roll back.
 */
import { realpath } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import type { AgentToolResult, AgentToolUpdateCallback } from "@earendil-works/pi-agent-core";
import type { ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import { Type, type Static, type TObject, type TProperties } from "typebox";
import {
  commitFreshness,
  unpublishedMutationFact,
  observePublishedRevision,
  type RevisionObservation,
} from "./file-commit.ts";
import { finalizeMutation, type MutationOutcome } from "./mutation-result.ts";
import { throwIfCancelled } from "./error-text.ts";
import { AnnotatedError } from "./tool-error.ts";
import {
  causeFacts,
  emptyReport,
  publishReport,
  mutationCompleted,
  type ReportDetails,
} from "./report.ts";
import type { ToolReport, CommandFact, ToolName, CauseFact } from "../core/report-schema.ts";

const MILLISECONDS_PER_SECOND = 1_000;
const MAX_BASH_TIMEOUT_SECONDS = 2_147_483_647 / MILLISECONDS_PER_SECOND;
export type MutationToolName = Extract<ToolName, "edit" | "replace" | "write">;
export type CommandStatus = Exclude<CommandFact["status"], "waiting" | "running">;
export const commandTimingSchema = Type.Object({
  timeoutSeconds: Type.Number(),
  remainingSeconds: Type.Number(),
});
export interface ActionFusionProgress {
  readonly toolCallId: string;
  readonly path: string;
  readonly commandText: string;
  readonly report: ToolReport & { command: CommandFact };
  readonly mutationCompleted: boolean;
  readonly timing?: Static<typeof commandTimingSchema>;
}
type ProgressReporter = (progress: ActionFusionProgress, ctx: ExtensionToolContext) => void;
export type CommandOutcome = Pick<CommandFact, "output" | "terminate"> & {
  readonly status: Exclude<CommandStatus, "not_requested" | "skipped">;
};
type CommandRunner = (
  toolCallId: string,
  input: ThenRunInput,
  signal: AbortSignal | undefined,
  ctx: ExtensionToolContext,
  onUpdate?: AgentToolUpdateCallback<unknown>,
) => Promise<CommandOutcome>;
export const ACTION_FUSION_GUIDELINES = [
  "Before each file mutation, identify its next command.",
  "Prefer then_run when the next command is known, authorized, and ready after the mutation succeeds.",
  "When several edits are prerequisites, attach then_run to the last one.",
  "Run the command separately if it depends on the mutation result, needs approval, or awaits a reload.",
  "Use platform-appropriate commands; avoid Unix-only paths like /tmp on Windows.",
  "Check the command outcome before claiming validation passed.",
];

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

/** Two observations across an event-loop turn detect a write in progress. */
async function observeBeforeCommand(path: string, baseline: string): Promise<RevisionObservation> {
  const before = await observePublishedRevision(path, baseline);
  if (before.freshness !== "unchanged") return before;
  await new Promise<void>((resolve) => setImmediate(resolve));
  return observePublishedRevision(path, baseline);
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
    displayPath: string;
    absolutePath: string;
    thenRun: ThenRunInput | undefined;
    mutate: () => Promise<MutationOutcome<TDetails>>;
    signal: AbortSignal | undefined;
    ctx: ExtensionToolContext;
    onUpdate?: AgentToolUpdateCallback<TDetails>;
  }): Promise<AgentToolResult<TDetails & ReportDetails>> {
    let completedMutation: MutationOutcome<TDetails> | undefined;
    let progressFailures: CauseFact[] | undefined;
    let commandTiming: { timeoutSeconds: number; deadlineMs: number } | undefined;
    const reportProgress = (command: CommandFact, observation?: RevisionObservation) => {
      if (!thenRun) return;
      const base = completedMutation
        ? finalizeMutation(
            completedMutation,
            observation ?? { freshness: commitFreshness(completedMutation.commit) },
          )
        : {
            content: [],
            details: {
              report: {
                ...emptyReport(tool),
                path: displayPath,
                mutation: unpublishedMutationFact(),
              },
            },
          };
      const report = { ...base.details.report, command };
      const timing = commandTiming
        ? {
            timeoutSeconds: commandTiming.timeoutSeconds,
            remainingSeconds: Math.max(
              0,
              Math.ceil((commandTiming.deadlineMs - Date.now()) / MILLISECONDS_PER_SECOND),
            ),
          }
        : undefined;
      const progress: ActionFusionProgress = {
        toolCallId,
        path: absolutePath,
        commandText: thenRun.command,
        report,
        mutationCompleted: mutationCompleted(report),
        ...(timing ? { timing } : {}),
      };
      const notifyUpdate = () => {
        if (!completedMutation) return;
        const update = publishReport(completedMutation.result, report);
        onUpdate?.(update);
      };
      for (const notify of [() => onProgress?.(progress, ctx), notifyUpdate]) {
        try {
          notify();
        } catch (error) {
          progressFailures ??= causeFacts(error);
        }
      }
    };
    const notRun = (error: unknown, status: "skipped" | "cancelled") => {
      const command: CommandFact = { status, blockedBy: "mutation", output: "" };
      reportProgress(command);
      return new AnnotatedError(error, {
        command,
        ...(progressFailures ? { progressFailures } : {}),
      });
    };
    reportProgress({ status: "waiting", output: "" });
    return withQueue(absolutePath, async () => {
      try {
        throwIfCancelled(signal);
      } catch (error) {
        if (thenRun) throw notRun(error, "cancelled");
        throw error;
      }
      let outcome: MutationOutcome<TDetails>;
      try {
        outcome = await mutate();
        completedMutation = outcome;
      } catch (error) {
        if (thenRun) throw notRun(error, "skipped");
        throw error;
      }
      if (!thenRun)
        return finalizeMutation(outcome, { freshness: commitFreshness(outcome.commit) });
      const settle = (command: CommandFact, observation: RevisionObservation) => {
        reportProgress(command, observation);
        const result = finalizeMutation(outcome, observation);
        const report = {
          ...result.details.report,
          command,
          ...(progressFailures ? { progressFailures } : {}),
        };
        return publishReport(
          {
            ...result,
            ...(command.terminate === undefined ? {} : { terminate: command.terminate }),
          },
          report,
        );
      };
      const observed = await observeBeforeCommand(absolutePath, outcome.commit.publishedRevision);
      if (signal?.aborted)
        return settle({ status: "cancelled", blockedBy: "cancellation", output: "" }, observed);
      if (observed.freshness !== "unchanged") {
        return settle(
          {
            status: "skipped",
            blockedBy: observed.freshness === "changed" ? "target" : "revision",
            output: "",
          },
          observed,
        );
      }
      let output = "";
      let command: CommandFact;
      let heartbeat: ReturnType<typeof setInterval> | undefined;
      reportProgress({ status: "running", output: "" }, observed);
      try {
        const final = await commandRunner(toolCallId, thenRun, signal, ctx, (partial) => {
          if (!commandTiming && thenRun.timeout !== undefined) {
            commandTiming = {
              timeoutSeconds: thenRun.timeout,
              deadlineMs: Date.now() + thenRun.timeout * MILLISECONDS_PER_SECOND,
            };
            if (onProgress || onUpdate) {
              heartbeat = setInterval(
                () => reportProgress({ status: "running", output }),
                MILLISECONDS_PER_SECOND,
              );
              heartbeat.unref();
            }
          }
          output = partial.content
            .filter((block) => block.type === "text")
            .map((block) => block.text)
            .join("\n");
          reportProgress({ status: "running", output });
        });
        command = final;
      } catch (error) {
        command = {
          status: signal?.aborted ? "cancelled" : "failed",
          output,
          causes: causeFacts(error),
        };
      } finally {
        if (heartbeat) clearInterval(heartbeat);
      }
      const freshness = await observePublishedRevision(
        absolutePath,
        outcome.commit.publishedRevision,
      );
      return settle(command, freshness);
    }).catch((error: unknown) => {
      if (!thenRun || error instanceof AnnotatedError) throw error;
      throw notRun(error, "skipped");
    });
  };
}
