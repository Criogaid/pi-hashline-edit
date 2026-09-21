import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { FileMutationError, type MutationVersions, type PublicationStatus } from "./file-commit.ts";
import { computeLineHash } from "../core/hash.ts";

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
): AgentToolResult<T> {
	try {
		const finalized = finalize(result, publishAnchors);
		return publishAnchors ? finalized : {
			...finalized,
			content: [...finalized.content, { type: "text", text: "Anchors omitted: target revision was not confirmed unchanged. Re-read before further edits." }],
		};
	} catch (error) {
		const publication = (result.details as { publication?: PublicationStatus } | undefined)?.publication ?? "UNKNOWN";
		throw new FileMutationError("post_process", publication, `Result generation failed; publication=${publication}. Re-read before retrying: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
	}
}

/** Bound complete anchor rows before hashing or constructing their output strings. */
export function formatMutationAnchors(lines: readonly string[], indices: Iterable<number>, hashLen: number, heading: string): string {
	const notice = "\n… (additional anchors omitted: 40-row/16 KiB limit; use read for full content)";
	const rows: string[] = [];
	let bytes = Buffer.byteLength(`\n${heading}\n`) + Buffer.byteLength(notice);
	let omitted = false;
	for (const index of indices) {
		const content = lines[index];
		const rowBytes = Buffer.byteLength(`${index + 1}#${"X".repeat(hashLen)}│`) + Buffer.byteLength(content) + 1;
		if (rows.length >= 40 || bytes + rowBytes > 16 * 1024) {
			omitted = true;
			break;
		}
		rows.push(`${index + 1}#${computeLineHash(index + 1, content, hashLen)}│${content}`);
		bytes += rowBytes;
	}
	return rows.length || omitted ? `\n${heading}\n${rows.join("\n")}${omitted ? notice : ""}` : "";
}
