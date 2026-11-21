/**
 * Mutation report building: details, diffs, and failure classification.
 *
 * @module pi-hashline-edit/pi
 */

import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { AgentToolUpdateCallback } from "@earendil-works/pi-agent-core";
import type { ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import type { ThenRunInput } from "./action-fusion.ts";
import {
  commitFreshness,
  FileMutationError,
  type CommitResult,
  type FreshnessObservation,
} from "./file-commit.ts";
import { generateRangeDiff } from "./mutation-diff.ts";
import { displayCarriageReturns } from "./anchor-format.ts";
import { errorMessage } from "../core/errors.ts";
import type { CopiedSpan } from "../core/copy-span.ts";
import type {
  ActionFusionProgress,
  CommandResult,
  CommandStatus,
  FailureReport,
  MutationToolName,
  ReportTool,
  SuccessFacts,
  SuccessReport,
} from "./report-schema.ts";
import {
  describeFailure,
  reportResult,
  type FailureContext,
  type ReportDetails,
} from "./report.ts";
import { boundedText, describeThrown } from "./report-cause.ts";
import type { OutputBudgets } from "./budgets.ts";

/** Final success carries tool details; final failure carries only its report; neither carries progress. */
export type MutationFinalDetails<TDetails> =
  | (TDetails & ReportDetails<SuccessReport> & { actionFusion?: never })
  | (ReportDetails<FailureReport> & { actionFusion?: never });

/** Progress can precede the mutation and carries no final report yet. */
export type MutationResultDetails<TDetails> =
  | MutationFinalDetails<TDetails>
  | (Partial<TDetails> & { actionFusion: ActionFusionProgress });

/** The diff of the shared logical text, which the card and Pi's session export both show. */
export function generateMutationDetails(
  before: string,
  after: string,
  copied: readonly CopiedSpan[],
) {
  return { diff: displayCarriageReturns(generateRangeDiff(before, after, copied)) };
}

/** The facts a mutation tool states about its own outcome. */
export type MutationFacts<TTool extends MutationToolName = MutationToolName> = {
  [T in TTool]: SuccessFacts<T> & {
    [K in Exclude<"matches", keyof SuccessFacts<T>>]?: never;
  };
}[TTool];

/** A published (or no-op) mutation with its commit facts, before freshness is known. */
export interface MutationOutcome<TDetails, TTool extends MutationToolName = MutationToolName> {
  /** Publication and revisions from the commit layer; later steps never read them back from details. */
  readonly commit: CommitResult;
  readonly details: TDetails;
  readonly facts: MutationFacts<TTool>;
}

/** The text blocks of a command result, joined as then_run reports its output. */
export function commandText(content: CommandResult["content"]): string {
  return content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n");
}

/** The first failure of a progress observer; any thrown value, `undefined` included. */
export interface ObserverFailure {
  readonly error: unknown;
}

/**
 * What Action Fusion states about the command; it never restates file state. A command that never
 * produced a result was skipped or cancelled; one with a result may still not have run, when a
 * permission hook blocked it with a reason.
 */
export type CommandFacts = (
  | { readonly status: Extract<CommandStatus, "skipped" | "cancelled">; readonly result?: never }
  | { readonly status: Exclude<CommandStatus, "skipped">; readonly result: CommandResult }
) & {
  /** The session Bash result's request to stop after this tool batch, as Pi gave it. */
  readonly terminate?: boolean;
};

/** A mutation that completed, with what is known about its target afterwards. */
interface SettledFacts<TDetails, TTool extends MutationToolName> {
  readonly outcome: MutationOutcome<TDetails, TTool>;
  readonly observation: FreshnessObservation;
}

/** A call without then_run settles alone; a fused call adds its command. */
export type SettledMutation<TDetails, TTool extends MutationToolName> = SettledFacts<
  TDetails,
  TTool
> &
  (
    | { readonly kind: "alone" }
    | {
        readonly kind: "fused";
        readonly command: CommandFacts;
        /** A progress observer failed; command and file outcomes are unaffected. */
        readonly progressFailure: ObserverFailure | undefined;
      }
  );

/** A mutation settled without a command: the commit result alone states its freshness. */
export function settleAlone<TDetails, TTool extends MutationToolName>(
  outcome: MutationOutcome<TDetails, TTool>,
): SettledMutation<TDetails, TTool> {
  return { kind: "alone", outcome, observation: commitFreshness(outcome.commit) };
}

/** One validated mutation call, as the scheduler receives it. */
export interface MutationCall<TDetails, TTool extends MutationToolName> {
  readonly toolCallId: string;
  readonly absolutePath: string;
  /** The model's optional follow-up command; only Action Fusion's schema admits it. */
  readonly thenRun: ThenRunInput | undefined;
  readonly mutate: () => Promise<MutationOutcome<TDetails, TTool>>;
  readonly signal: AbortSignal;
  readonly ctx: ExtensionToolContext;
  readonly onUpdate: AgentToolUpdateCallback<MutationResultDetails<TDetails>>;
}

/** Runs mutation calls; chosen once at registration from the actionFusion setting. */
export type MutationScheduler = <TDetails extends object, TTool extends MutationToolName>(
  call: MutationCall<TDetails, TTool>,
) => Promise<SettledMutation<TDetails, TTool>>;

function observerFailure(failure: ObserverFailure | undefined, budget: OutputBudgets) {
  return failure && describeThrown(failure.error, budget.fieldBytes);
}

/**
 * A mutation that did not complete, so its then_run command never ran. Action
 * Fusion owns the command status; the mutation's own failure stays unchanged.
 */
export class CommandNotRun extends Error {
  readonly status: Extract<CommandStatus, "skipped" | "cancelled">;
  /** A progress observer failed; the mutation's failure is unaffected. */
  readonly progressFailure: ObserverFailure | undefined;

  constructor(
    error: unknown,
    status: Extract<CommandStatus, "skipped" | "cancelled">,
    progressFailure: ObserverFailure | undefined,
  ) {
    super(errorMessage(error), { cause: error });
    this.name = "CommandNotRun";
    this.status = status;
    this.progressFailure = progressFailure;
  }
}

/**
 * Classify a mutation tool's failure with what only a mutation states: what it published and,
 * when the call was fused, why its command never ran.
 */
export function describeMutationFailure(
  tool: ReportTool,
  caught: unknown,
  context: FailureContext,
): FailureReport {
  const command = caught instanceof CommandNotRun ? caught : undefined;
  // The mutation's own failure, unchanged.
  const error = command ? command.cause : caught;
  return describeFailure(tool, error, context, {
    publication: error instanceof FileMutationError ? error.publication : "NOT_PUBLISHED",
    then_run: command ? { status: command.status } : undefined,
    progressError: observerFailure(command?.progressFailure, context.budget),
  });
}

/**
 * Build the mutation result from commit, freshness, and command facts; the TUI uses its diff
 * details. A fused call's command output is the result's payload, which the report follows with
 * the command's status; scripts read both in `then_run`.
 */
export function finalizeMutation<TDetails extends object, TTool extends MutationToolName>(
  tool: TTool,
  path: string,
  settled: SettledMutation<TDetails, NoInfer<TTool>>,
  budget: OutputBudgets,
): AgentToolResult<TDetails & ReportDetails<SuccessReport>> {
  const { commit, details, facts } = settled.outcome;
  const { observation } = settled;
  // Tool-indexed facts preserve the correlation that object spread loses.
  const report = {
    tool,
    path,
    publication: commit.publication,
    ...facts,
    freshness: observation.freshness === "unchanged" ? undefined : observation.freshness,
    freshnessError:
      observation.freshness === "unknown"
        ? describeThrown(observation.error, budget.fieldBytes)
        : undefined,
  } as SuccessReport & { tool: MutationToolName };
  if (settled.kind === "alone")
    return reportResult<TDetails, MutationToolName>(report, [], budget, { details });

  const { command } = settled;
  const then_run = { status: command.status };
  const output = command.result === undefined ? "" : commandText(command.result.content);
  const shown = boundedText(output, budget.fieldBytes);
  return reportResult<TDetails, MutationToolName>(
    { ...report, then_run, progressError: observerFailure(settled.progressFailure, budget) },
    shown ? [{ type: "text", text: shown }] : [],
    budget,
    { details, implied: shown ? { then_run: { ...then_run, output: shown } } : {} },
  );
}
