import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { FileMutationError, type MutationVersions, type PublicationStatus } from "./file-commit.ts";
import type { AnchorFormatter } from "./anchor-format.ts";

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

/** Bound anchor entries; an optional set selects which indices retain full content. */
export function formatMutationAnchors(
	lines: readonly string[], indices: Iterable<number>, anchors: AnchorFormatter, heading: string,
	contentIndices?: ReadonlySet<number>,
): string {
	const notice = "\n… (additional anchors omitted: 40-row/16 KiB limit; use read for full content)";
	const rows: string[] = [];
	let bytes = Buffer.byteLength(`\n${heading}\n`) + Buffer.byteLength(notice);
	let omitted = false;
	for (const index of indices) {
		const content = lines[index];
		const includeContent = contentIndices === undefined || contentIndices.has(index);
		const token = anchors.token(index + 1, content);
		const row = includeContent ? `${token}│${content}` : token;
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
