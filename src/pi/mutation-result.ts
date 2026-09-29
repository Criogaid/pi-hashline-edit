import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { FileMutationError, type MutationVersions, type PublicationStatus } from "./file-commit.ts";
import { generateDiffString, generateUnifiedPatch } from "@earendil-works/pi-coding-agent";
import { displayCarriageReturns, type AnchorFormatter } from "./anchor-format.ts";
import { normalizeLineEndings } from "../core/lines.ts";
import { errorMessage } from "./error-text.ts";
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

/** Append only to the summary block after the caller confirms anchor freshness. */
export function appendMutationAnchors<T>(
  result: AgentToolResult<T>,
  anchors: string,
  publish: boolean,
): AgentToolResult<T> {
  return {
    ...result,
    content: result.content.map((block, index) =>
      index === 0 && block.type === "text"
        ? { ...block, text: `${block.text}${publish ? anchors : ""}` }
        : block,
    ),
  };
}

export function observedFreshness(
  result: AgentToolResult<unknown>,
): "unchanged" | "changed" | "unknown" {
  const versions = result.details as Partial<MutationVersions> | undefined;
  if (!versions?.publishedRevision || !versions.observedRevision) return "unknown";
  return versions.publishedRevision === versions.observedRevision ? "unchanged" : "changed";
}

/** Finalize from the observed commit revision unless a later freshness check supplies the decision. */
export function finalizeMutationResult<T>(
  result: AgentToolResult<T>,
  finalize: (result: AgentToolResult<T>, publishAnchors: boolean) => AgentToolResult<T>,
  publishAnchors = observedFreshness(result) === "unchanged",
  staleNotice = "Anchors omitted: target revision was not confirmed unchanged. Re-read before further edits.",
): AgentToolResult<T> {
  try {
    const finalized = finalize(result, publishAnchors);
    return publishAnchors
      ? finalized
      : {
          ...finalized,
          content: [...finalized.content, { type: "text", text: staleNotice }],
        };
  } catch (error) {
    const publication =
      (result.details as { publication?: PublicationStatus } | undefined)?.publication ?? "UNKNOWN";
    throw new FileMutationError(
      "post_process",
      publication,
      `Result generation failed; publication=${publication}. Re-read before retrying: ${errorMessage(error)}`,
      { cause: error },
    );
  }
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
