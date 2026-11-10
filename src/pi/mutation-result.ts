/**
 * Mutation report building: details, diffs, and failure classification.
 *
 * @module pi-hashline-edit/pi
 */

import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { FileMutationError, type CommitResult, type FreshnessObservation } from "./file-commit.ts";
import { generateDiffString } from "@earendil-works/pi-coding-agent";
import { displayCarriageReturns } from "./anchor-format.ts";
import { errorMessage } from "../core/errors.ts";
import { normalizeLineEndings } from "../core/lines.ts";
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
import { causeOf } from "./report-cause.ts";
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
export function generateMutationDetails(before: string, after: string) {
  const { diff } = generateDiffString(normalizeLineEndings(before), normalizeLineEndings(after));
  return { diff: displayCarriageReturns(diff) };
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

/** What Action Fusion states about the command; it never restates file state. */
export interface CommandFacts {
  readonly status: CommandStatus;
  /** Absent when the command never produced a result. */
  readonly result?: CommandResult;
  /** A progress observer failed; command and file outcomes are unaffected. */
  readonly progressError?: unknown;
}

/**
 * A mutation that did not complete, so its then_run command never ran. Action
 * Fusion owns the command status; the mutation's own failure stays unchanged.
 */
export class CommandNotRun extends Error {
  readonly status: Extract<CommandStatus, "skipped" | "cancelled">;
  /** A progress observer failed; the mutation's failure is unaffected. */
  readonly progressError: unknown;

  constructor(
    error: unknown,
    status: Extract<CommandStatus, "skipped" | "cancelled">,
    progressError?: unknown,
  ) {
    super(errorMessage(error), { cause: error });
    this.name = "CommandNotRun";
    this.status = status;
    this.progressError = progressError;
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
    progressError: causeOf(command?.progressError, context.budget.fieldBytes),
  });
}

/** Build the mutation report from commit, freshness, and command facts; the TUI uses its diff details. */
export function finalizeMutation<TDetails extends object, TTool extends MutationToolName>(
  tool: TTool,
  path: string,
  { commit, details, facts }: MutationOutcome<TDetails, NoInfer<TTool>>,
  observation: FreshnessObservation,
  command: CommandFacts | undefined,
  budget: OutputBudgets,
): AgentToolResult<TDetails & ReportDetails<SuccessReport>> {
  const fresh = observation.freshness === "unchanged";
  const output = command?.result ? commandText(command.result.content) : "";
  // Tool-indexed facts preserve the correlation that object spread loses.
  const report = {
    tool,
    path,
    publication: commit.publication,
    ...facts,
    freshness: fresh ? undefined : observation.freshness,
    freshnessError: causeOf(observation.error, budget.fieldBytes),
    then_run: command ? { status: command.status, ...(output ? { output } : {}) } : undefined,
    progressError: causeOf(command?.progressError, budget.fieldBytes),
  } as SuccessReport;
  return reportResult(report, [], details);
}
