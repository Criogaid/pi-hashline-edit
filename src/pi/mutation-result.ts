/** Mutation payload construction; publication and freshness come from the commit owner. */
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import {
  FileMutationError,
  mutationFact,
  type CommitResult,
  type PublicationStatus,
  type RevisionObservation,
} from "./file-commit.ts";
import { generateDiffString, generateUnifiedPatch } from "@earendil-works/pi-coding-agent";
import { displayCarriageReturns, type AnchorFormatter } from "./anchor-format.ts";
import { normalizeLineEndings } from "../core/lines.ts";
import { MAX_BLOCK_BYTES } from "./budgets.ts";
import type { AnchorReport } from "../core/report-schema.ts";
import type { ReportDetails } from "./report.ts";

export function generateMutationDetails(path: string, before: string, after: string) {
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
  };
}
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
export interface MutationOutcome<TDetails> {
  readonly result: AgentToolResult<TDetails & ReportDetails>;
  readonly commit: CommitResult;
  readonly anchors?: AnchorReport;
}
/** Freshness governs the release of anchors; it never changes a completed mutation's outcome. */
export function finalizeMutation<T>(
  { result, commit, anchors }: MutationOutcome<T>,
  observation: RevisionObservation,
): AgentToolResult<T & ReportDetails> {
  const report = {
    ...result.details.report,
    mutation: mutationFact(commit, observation),
    anchors: observation.freshness === "unchanged" ? anchors : undefined,
  };
  return { ...result, details: { ...result.details, report } };
}
/** Complete anchor rows within the shared budget, with an explicit omitted-row count. */
export function formatMutationAnchors(
  beforeLines: readonly string[],
  lines: readonly string[],
  indices: Iterable<number>,
  anchors: AnchorFormatter,
  contentIndices?: ReadonlySet<number>,
): AnchorReport {
  const rows: string[] = [];
  let bytes = 0,
    omitted = 0;
  for (const index of indices) {
    const content = lines[index];
    if (beforeLines[index] === content && !contentIndices?.has(index)) continue;
    const row = contentIndices?.has(index)
      ? anchors.row(index + 1, content)
      : anchors.token(index + 1, content);
    const rowBytes = Buffer.byteLength(row) + (rows.length ? 1 : 0);
    if (bytes + rowBytes > MAX_BLOCK_BYTES) {
      omitted++;
      continue;
    }
    rows.push(row);
    bytes += rowBytes;
  }
  return { rows: rows.join("\n"), omitted, maxBytes: MAX_BLOCK_BYTES };
}
