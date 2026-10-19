/**
 * Mutation report building: details, diffs, and post-process outcome
 * classification.
 *
 * @module pi-hashline-edit/pi
 */

import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import {
  FileMutationError,
  type CommitResult,
  type FreshnessObservation,
  type MutationVersions,
} from "./file-commit.ts";
import { generateDiffString, generateUnifiedPatch } from "@earendil-works/pi-coding-agent";
import { displayCarriageReturns } from "./anchor-format.ts";
import { normalizeLineEndings } from "../core/lines.ts";
import type {
  CommandResult,
  CommandStatus,
  FailureReport,
  MutationToolName,
  PublicationStatus,
  SuccessFacts,
  SuccessReport,
} from "./report-schema.ts";
import { causeOf, reportResult, type ReportDetails } from "./report.ts";
import { DEFAULT_OUTPUT_BUDGETS, type OutputBudgets } from "./budgets.ts";
import type { ActionFusionProgress } from "./action-fusion.ts";

/** Final success carries tool details; final failure carries only its report; neither carries progress. */
export type MutationFinalDetails<TDetails> =
  | (TDetails & ReportDetails<SuccessReport> & { actionFusion?: never })
  | (ReportDetails<FailureReport> & { actionFusion?: never });

/** Progress can precede the mutation and carries no final report yet. */
export type MutationResultDetails<TDetails> =
  | MutationFinalDetails<TDetails>
  | (Partial<TDetails> & { actionFusion: ActionFusionProgress });

/** Keep byte-faithful diff/patch data and a separate preview of the shared logical text. */
export function generateMutationDetails(
  path: string,
  before: string,
  after: string,
  versions: MutationVersions,
  publication: PublicationStatus,
) {
  const { diff, firstChangedLine } = generateDiffString(before, after);
  const logicalBefore = normalizeLineEndings(before);
  const logicalAfter = normalizeLineEndings(after);
  const displayDiff =
    logicalBefore === before && logicalAfter === after
      ? diff
      : generateDiffString(logicalBefore, logicalAfter).diff;
  return {
    diff: displayCarriageReturns(diff),
    displayDiff: displayCarriageReturns(displayDiff),
    firstChangedLine,
    patch: generateUnifiedPatch(path, before, after),
    publication,
    ...versions,
  };
}

/** Keep result-building failures distinct from file publication failures. */
export function postProcessMutation<T>(publication: PublicationStatus, build: () => T): T {
  try {
    return build();
  } catch (error) {
    throw new FileMutationError(
      "POST_PROCESS_FAILED",
      "post_process",
      publication,
      "Result generation failed.",
      { cause: error },
    );
  }
}

/** The facts a mutation tool states about its own outcome. */
export type MutationFacts<TTool extends MutationToolName = MutationToolName> = {
  [T in TTool]: SuccessFacts<T> & {
    [K in Exclude<"matches" | "created", keyof SuccessFacts<T>>]?: never;
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

/** Build the mutation report from commit, freshness, and command facts; the TUI uses its diff details. */
export function finalizeMutation<TDetails extends object, TTool extends MutationToolName>(
  tool: TTool,
  path: string,
  { commit, details, facts }: MutationOutcome<TDetails, NoInfer<TTool>>,
  observation: FreshnessObservation,
  command?: CommandFacts,
  budget: OutputBudgets = DEFAULT_OUTPUT_BUDGETS,
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
