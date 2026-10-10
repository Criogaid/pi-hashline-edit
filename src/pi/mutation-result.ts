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
import type { CommandStatus, PublicationStatus, Report } from "./report-schema.ts";
import { causeOf, reportResult, type ReportDetails } from "./report.ts";
import { DEFAULT_OUTPUT_BUDGETS, type OutputBudgets } from "./budgets.ts";

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
export type MutationFacts = Pick<Report, "matches" | "created">;

/** A published (or no-op) mutation with its commit facts, before freshness is known. */
export interface MutationOutcome<TDetails> {
  /** Publication and revisions from the commit layer; later steps never read them back from details. */
  readonly commit: CommitResult;
  readonly details: TDetails;
  readonly facts: MutationFacts;
}

/** What Action Fusion states about the command; it never restates file state. */
export interface CommandFacts {
  readonly status: CommandStatus;
  readonly output?: string;
  /** A progress observer failed; command and file outcomes are unaffected. */
  readonly progressError?: unknown;
}

/** Build the mutation report from commit, freshness, and command facts; the TUI uses its diff details. */
export function finalizeMutation<TDetails extends object>(
  tool: string,
  path: string,
  { commit, details, facts }: MutationOutcome<TDetails>,
  observation: FreshnessObservation,
  command?: CommandFacts,
  budget: OutputBudgets = DEFAULT_OUTPUT_BUDGETS,
): AgentToolResult<TDetails & ReportDetails> {
  const fresh = observation.freshness === "unchanged";
  const report: Report = {
    tool,
    path,
    publication: commit.publication,
    ...facts,
    freshness: fresh ? undefined : observation.freshness,
    freshnessError: causeOf(observation.error, budget.fieldBytes),
    then_run: command
      ? { status: command.status, ...(command.output ? { output: command.output } : {}) }
      : undefined,
    progressError: causeOf(command?.progressError, budget.fieldBytes),
  };
  return reportResult(report, [], details);
}
