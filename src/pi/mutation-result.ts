import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import {
  FileMutationError,
  type CommitResult,
  type MutationVersions,
  type PublicationStatus,
} from "./file-commit.ts";
import { generateDiffString, generateUnifiedPatch } from "@earendil-works/pi-coding-agent";
import { displayCarriageReturns, type AnchorFormatter } from "./anchor-format.ts";
import { normalizeLineEndings } from "../core/lines.ts";
import { errorMessage } from "../core/errors.ts";
import { formatKiB, MAX_BLOCK_BYTES } from "./budgets.ts";

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
export function postProcessMutation<T>(
  tool: string,
  publication: PublicationStatus,
  build: () => T,
): T {
  try {
    return build();
  } catch (error) {
    throw new FileMutationError(
      "post_process",
      publication,
      `${tool} result generation failed; publication=${publication}: ${errorMessage(error)}`,
      { cause: error },
    );
  }
}

/** A published (or no-op) mutation with its commit facts, before anchors are released. */
export interface MutationOutcome<TDetails> {
  readonly result: AgentToolResult<TDetails>;
  /** Publication and revisions from the commit layer; later steps never read them back from details. */
  readonly commit: CommitResult;
  /** Fresh anchor report for the committed text; absent for tools that never report anchors. */
  readonly anchors?: string;
}

/** Freshness known from the commit layer alone, before any later observation. */
export function commitFreshness(commit: MutationVersions): "unchanged" | "changed" {
  return commit.publishedRevision === commit.observedRevision ? "unchanged" : "changed";
}

/** The single notice for a target whose published revision was not confirmed unchanged. */
export function staleTargetNotice(marker = ""): string {
  return `${marker ? `${marker} ` : ""}Target not confirmed unchanged since publication; anchors are withheld and earlier anchors may no longer match. Re-read before further edits.`;
}

/**
 * Release the result: append anchors to the summary when the target is fresh,
 * otherwise add the stale notice (prefixed by `staleMarker`, e.g. then_run's).
 */
export function finalizeMutation<T>(
  { result, anchors }: MutationOutcome<T>,
  fresh: boolean,
  staleMarker = "",
): AgentToolResult<T> {
  if (!fresh) {
    return {
      ...result,
      content: [...result.content, { type: "text", text: staleTargetNotice(staleMarker) }],
    };
  }
  if (!anchors) return result;
  return {
    ...result,
    content: result.content.map((block, index) =>
      index === 0 && block.type === "text" ? { ...block, text: block.text + anchors } : block,
    ),
  };
}

/** Return compact changed-position anchors; selected context rows retain full content within the byte budget. */
export function formatMutationAnchors(
  beforeLines: readonly string[],
  lines: readonly string[],
  indices: Iterable<number>,
  anchors: AnchorFormatter,
  heading: string,
  contentIndices?: ReadonlySet<number>,
): string {
  const notice = `\n… (additional anchors omitted: ${formatKiB(MAX_BLOCK_BYTES)} limit; use read for omitted positions)`;
  const prefix = `\n${heading}\n`;
  let rows: string[] = [];
  let bytes = Buffer.byteLength(prefix);
  let omitted = false;
  const append = (row: string): boolean => {
    const rowBytes = Buffer.byteLength(row) + (rows.length ? 1 : 0);
    if (bytes + rowBytes > MAX_BLOCK_BYTES) return false;
    rows.push(row);
    bytes += rowBytes;
    return true;
  };
  for (const index of indices) {
    const content = lines[index];
    // Compare source content, not short hashes: a collision must not suppress a changed row.
    // Deletion successors (contentIndices) shifted into this position and must not be skipped.
    if (beforeLines[index] === content && !contentIndices?.has(index)) continue;
    const row = contentIndices?.has(index)
      ? anchors.row(index + 1, content)
      : anchors.token(index + 1, content);
    if (append(row) || omitted) continue;
    // Only reserve a notice after overflow. Reconsider earlier rows in order so
    // a newly oversized row does not prevent later, shorter rows from fitting.
    omitted = true;
    const previousRows = rows;
    rows = [];
    bytes = Buffer.byteLength(prefix) + Buffer.byteLength(notice);
    for (const previous of previousRows) append(previous);
    append(row);
  }
  return rows.length || omitted ? `${prefix}${rows.join("\n")}${omitted ? notice : ""}` : "";
}
