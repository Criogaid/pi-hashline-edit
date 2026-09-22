import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { FileMutationError, type MutationVersions, type PublicationStatus } from "./file-commit.ts";
import { generateDiffString, generateUnifiedPatch } from "@earendil-works/pi-coding-agent";
import { displayCarriageReturns, type AnchorFormatter } from "./anchor-format.ts";

/** Diff raw text so line numbers and patches retain LF boundaries and all source bytes. */
export function generateMutationDetails(path: string, before: string, after: string, versions: MutationVersions, publication: PublicationStatus) {
	const { diff, firstChangedLine } = generateDiffString(before, after);
	return {
		diff: displayCarriageReturns(diff),
		firstChangedLine,
		patch: generateUnifiedPatch(path, before, after),
		publication,
		...versions,
		revision: versions.publishedRevision,
	};
}

/** Keep result-building failures distinct from file publication failures. */
export function postProcessMutation<T>(tool: string, publication: PublicationStatus, build: () => T): T {
	try { return build(); } catch (error) {
		throw new FileMutationError("post_process", publication, `${tool} result generation failed; publication=${publication}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
	}
}

/** Append only to the summary block after the caller confirms anchor freshness. */
export function appendMutationAnchors<T>(result: AgentToolResult<T>, anchors: string, publish: boolean): AgentToolResult<T> {
	return {
		...result,
		content: result.content.map((block, index) => index === 0 && block.type === "text"
			? { ...block, text: `${block.text}${publish ? anchors : ""}` } : block),
	};
}

export function observedFreshness(result: AgentToolResult<unknown>): "unchanged" | "changed" | "unknown" {
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
		return publishAnchors ? finalized : {
			...finalized,
			content: [...finalized.content, { type: "text", text: staleNotice }],
		};
	} catch (error) {
		const publication = (result.details as { publication?: PublicationStatus } | undefined)?.publication ?? "UNKNOWN";
		throw new FileMutationError("post_process", publication, `Result generation failed; publication=${publication}. Re-read before retrying: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
	}
}

/** Omit unchanged positions before budgeting anchors; contentIndices selects rows needing full content. */
export function formatMutationAnchors(
	beforeLines: readonly string[], lines: readonly string[], indices: Iterable<number>, anchors: AnchorFormatter, heading: string,
	contentIndices?: ReadonlySet<number>,
): string {
	const notice = "\n… (additional anchors omitted: 40-row/16 KiB limit; use read for full content)";
	const rows: string[] = [];
	let bytes = Buffer.byteLength(`\n${heading}\n`) + Buffer.byteLength(notice);
	let omitted = false;
	for (const index of indices) {
		const content = lines[index];
		// Compare source content, not short hashes: a collision must not suppress a changed row.
		if (beforeLines[index] === content) continue;
		const includeContent = contentIndices === undefined || contentIndices.has(index);
		const row = includeContent ? anchors.row(index + 1, content) : anchors.token(index + 1, content);
		const rowBytes = Buffer.byteLength(row) + 1;
		if (rows.length >= 40 || bytes + rowBytes > 16 * 1024) {
			omitted = true;
			break;
		}
		rows.push(row);
		bytes += rowBytes;
	}
	return rows.length || omitted ? `\n${heading}\n${rows.join("\n")}${omitted ? notice : ""}` : "";
}
