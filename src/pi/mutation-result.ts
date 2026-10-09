import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import {
  FileMutationError,
  type CommitResult,
  type FreshnessObservation,
  type MutationVersions,
} from "./file-commit.ts";
import { generateDiffString, generateUnifiedPatch } from "@earendil-works/pi-coding-agent";
import { displayCarriageReturns, type AnchorFormatter } from "./anchor-format.ts";
import { normalizeLineEndings } from "../core/lines.ts";
import { MAX_BLOCK_BYTES } from "./budgets.ts";
import type { CommandStatus, PublicationStatus, Report } from "./report-schema.ts";
import { causeOf, reportResult, type ReportDetails } from "./report.ts";

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

/** Updated anchor rows and how many changed positions did not fit their budget. */
export interface AnchorReport {
  /** The heading and rows; empty when no changed position remains. */
  readonly text: string;
  readonly omitted: number;
}

/** The facts a mutation tool states about its own outcome. */
export type MutationFacts = Pick<Report, "matches" | "created">;

/** A published (or no-op) mutation with its commit facts, before freshness is known. */
export interface MutationOutcome<TDetails> {
  /** Publication and revisions from the commit layer; later steps never read them back from details. */
  readonly commit: CommitResult;
  readonly details: TDetails;
  readonly facts: MutationFacts;
  /** Fresh anchor report for the committed text; absent for tools that never report anchors. */
  readonly anchors?: AnchorReport;
}

/** What Action Fusion states about the command; it never restates file state. */
export interface CommandFacts {
  readonly status: CommandStatus;
  readonly output?: string;
  /** A progress observer failed; command and file outcomes are unaffected. */
  readonly progressError?: unknown;
}

/**
 * Build the mutation's result from its facts: the anchor rows are the payload
 * only while the target is fresh; otherwise freshness states the target, and
 * the report's `next` asks for a re-read. Command facts come from Fusion.
 */
export function finalizeMutation<TDetails extends object>(
  tool: string,
  path: string,
  { commit, details, facts, anchors }: MutationOutcome<TDetails>,
  observation: FreshnessObservation,
  command?: CommandFacts,
): AgentToolResult<TDetails & ReportDetails> {
  const fresh = observation.freshness === "unchanged";
  const report: Report = {
    tool,
    path,
    publication: commit.publication,
    ...facts,
    omittedAnchors: fresh && anchors?.omitted ? anchors.omitted : undefined,
    freshness: fresh ? undefined : observation.freshness,
    freshnessError: causeOf(observation.error),
    then_run: command
      ? { status: command.status, ...(command.output ? { output: command.output } : {}) }
      : undefined,
    progressError: causeOf(command?.progressError),
  };
  const payload =
    fresh && anchors?.text ? [{ type: "text" as const, text: anchors.text }] : undefined;
  return reportResult(report, payload, details);
}

/** Return compact changed-position anchors; selected context rows retain full content within the byte budget. */
export function formatMutationAnchors(
  beforeLines: readonly string[],
  lines: readonly string[],
  indices: Iterable<number>,
  anchors: AnchorFormatter,
  heading: string,
  contentIndices?: ReadonlySet<number>,
): AnchorReport {
  const prefix = `${heading}\n`;
  const rows: string[] = [];
  let bytes = Buffer.byteLength(prefix);
  let omitted = 0;
  for (const index of indices) {
    const content = lines[index];
    // Compare source content, not short hashes: a collision must not suppress a changed row.
    // Deletion successors (contentIndices) shifted into this position and must not be skipped.
    if (beforeLines[index] === content && !contentIndices?.has(index)) continue;
    const row = contentIndices?.has(index)
      ? anchors.row(index + 1, content)
      : anchors.token(index + 1, content);
    // Rows that do not fit are omitted whole; later rows that fit are still returned.
    const rowBytes = Buffer.byteLength(row) + (rows.length ? 1 : 0);
    if (bytes + rowBytes > MAX_BLOCK_BYTES) {
      omitted++;
      continue;
    }
    rows.push(row);
    bytes += rowBytes;
  }
  return { text: rows.length ? `${prefix}${rows.join("\n")}` : "", omitted };
}
