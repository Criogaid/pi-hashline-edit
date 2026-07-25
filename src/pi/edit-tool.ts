/**
 * Override edit: hashline ops via structured `edits` (LINE#HASH anchors).
 *
 * Each op in `edits` references line anchors copied from read output (or from a
 * prior edit's "Updated anchors"). The core verifies each anchor live against
 * the current file content — no snapshot, no global stale check: a cited line
 * that changed (or was misremembered) fails its own anchor; unchanged lines
 * elsewhere never block the edit. Legacy oldText/newText is not accepted — the
 * schema requires an `op` discriminator, so legacy payloads are rejected at the
 * schema layer (a visible failure, never a silent degradation).
 *
 * On success the result carries fresh `LINE#HASH` anchors for the lines this
 * edit produced (and the line that shifted into a deletion gap), so the model
 * can chain edits without a re-read.
 *
 * Concurrency safety: read-modify-write is wrapped in withFileMutationQueue.
 * AbortSignal is honored — checked after read / before write.
 *
 * @module pi-hashline-edit/pi
 */

import { createEditTool, generateDiffString, generateUnifiedPatch, withFileMutationQueue, type EditToolDetails } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { Text } from "@earendil-works/pi-tui";
import { readFile, writeFile } from "node:fs/promises";
import { applyEdits, hashFileLines } from "../core/index.ts";
import { splitLines } from "../core/lines.ts";
import type { Edit, PatchError } from "../core/types.ts";
import { canonicalPath } from "./read-tool.ts";
import { getState } from "./state.ts";

/** Cap on the number of updated anchors returned inline (bounds token cost for large inserts). */
const MAX_ANCHOR_LINES = 40;

const anchorSchema = Type.Object({
	line: Type.Number({ description: "1-based line number" }),
	hash: Type.String({ description: "Line content hash copied from read output (the #HASH after the line number)" }),
});

const editOpSchema = Type.Object({
	op: Type.Union(
		[
			Type.Literal("replace"),
			Type.Literal("delete"),
			Type.Literal("insert_after"),
			Type.Literal("insert_before"),
			Type.Literal("append"),
			Type.Literal("prepend"),
		],
		{ description: "Operation kind" },
	),
	anchor: Type.Optional(anchorSchema),
	end: Type.Optional(anchorSchema),
	body: Type.Optional(Type.Array(Type.String(), { description: "New content lines (required for replace/insert/append/prepend; omit for delete)" })),
});

const editSchema = Type.Object({
	path: Type.String({ description: "Path to the file to edit (relative or absolute)" }),
	edits: Type.Array(editOpSchema, { description: "Hashline ops, each referencing LINE#HASH anchors from your latest read or edit result" }),
});

type EditOpInput = Static<typeof editOpSchema>;

/** Turn a PatchError into helpful hint text for the model. */
function errorText(e: PatchError, path: string): string {
	switch (e.kind) {
		case "anchor":
			return `Anchor mismatch: ${e.message}. Re-read ${path} to get current line hashes (LINE#HASH).`;
		case "range":
			return `Bad range: ${e.message}`;
		case "noop":
			return `Edit produced no change: ${e.message}`;
	}
}

/** Translate JSON edit ops into core Edit[]. Validates conditional required fields (anchor/body per op). */
function toCoreEdits(ops: readonly EditOpInput[]): { ok: true; edits: Edit[] } | { ok: false; error: string } {
	const edits: Edit[] = [];
	for (const o of ops) {
		switch (o.op) {
			case "replace":
				if (!o.anchor) return { ok: false, error: "replace needs `anchor` {line, hash}" };
				if (!o.body) return { ok: false, error: "replace needs `body`" };
				edits.push({ op: "replace", start: o.anchor, end: o.end, body: o.body });
				break;
			case "delete":
				if (!o.anchor) return { ok: false, error: "delete needs `anchor` {line, hash}" };
				edits.push({ op: "delete", start: o.anchor, end: o.end });
				break;
			case "insert_after":
			case "insert_before":
				if (!o.anchor) return { ok: false, error: `${o.op} needs \`anchor\` {line, hash}` };
				if (!o.body) return { ok: false, error: `${o.op} needs \`body\`` };
				edits.push({ op: o.op, anchor: o.anchor, body: o.body });
				break;
			case "append":
			case "prepend":
				if (!o.body) return { ok: false, error: `${o.op} needs \`body\`` };
				edits.push({ op: o.op, body: o.body });
				break;
		}
	}
	return { ok: true, edits };
}

/** Build an error result (isError: true so the TUI/agent loop treats it as a failure). */
function errResult(text: string) {
	return {
		isError: true as const,
		content: [{ type: "text" as const, text }],
		details: undefined,
	};
}

/**
 * Format the updated anchors (fresh LINE#HASH│content) for the touched new-file
 * lines, so the model can chain edits without a re-read. Capped to bound tokens.
 */
function formatUpdatedAnchors(newText: string, touched: readonly number[], hashLen: number): string {
	const newLines = splitLines(newText);
	const newHashes = hashFileLines(newLines, hashLen);
	const idxs = [...new Set(touched)].sort((a, b) => a - b);
	if (idxs.length === 0) return "";
	const rows = idxs.map((i) => `${i + 1}#${newHashes[i]}│${newLines[i]}`);
	const shown = rows.length > MAX_ANCHOR_LINES ? rows.slice(0, MAX_ANCHOR_LINES) : rows;
	const more = rows.length > MAX_ANCHOR_LINES ? `\n… (${rows.length - MAX_ANCHOR_LINES} more; re-read for full anchors)` : "";
	return `\nUpdated anchors (use these for the next edit):\n${shown.join("\n")}${more}`;
}

export function makeEditOverride(cwd: string) {
	const builtin = createEditTool(cwd);

	return {
		name: "edit" as const,
		label: "edit",
		description:
			"Edit a file via hashline ops (LINE#HASH anchors, content-verified). Each op in `edits` references line anchors from your latest read or edit result.",
		promptSnippet: "Edit files via hashline ops (edits[] with LINE#HASH anchors from read)",
		promptGuidelines: [
			"Pass `edits`: an array of ops. Each op = {op, anchor?, end?, body?}.",
			"op ∈ replace | delete | insert_after | insert_before | append | prepend.",
			"anchor & end = {line, hash} copied from your latest read or edit result (the `#HASH` after each line number). replace/delete take anchor (+ optional end for a range); insert_after/insert_before take anchor; append/prepend take neither.",
			"body = string[] of new content lines (required for replace/insert/append/prepend; omit for delete).",
			"A successful edit returns `Updated anchors` for the changed lines — use those (not stale line numbers) for the next edit to the same file; re-read only if you need lines outside that set.",
		],
		parameters: editSchema,
		renderShell: "self" as const,

		renderCall(args: Static<typeof editSchema>, theme: any) {
			let text = theme.fg("toolTitle", theme.bold("edit "));
			text += theme.fg("accent", args.path);
			const n = args.edits?.length ?? 0;
			if (n) text += theme.fg("dim", ` — ${n} op${n > 1 ? "s" : ""}: ${args.edits[0].op}`);
			return new Text(text, 0, 0);
		},

		renderResult(result: any, { isPartial, expanded }: any, theme: any) {
			if (isPartial) return new Text(theme.fg("warning", "Editing…"), 0, 0);
			const content = result.content?.[0];
			if (result.isError) {
				const t = content?.type === "text" ? content.text.split("\n")[0] : "Error";
				return new Text(theme.fg("error", t), 0, 0);
			}
			const diff: string | undefined = result.details?.diff;
			if (!diff) {
				const t = content?.type === "text" ? content.text : "Edited";
				return new Text(theme.fg("success", t), 0, 0);
			}
			// details.diff is pi-format (+N/-N/<space>N content); color by leading char
			const allLines = diff.split("\n");
			const shown = expanded ? allLines : allLines.slice(0, 24);
			const body = shown
				.map((line: string) => {
					if (line.startsWith("+")) return theme.fg("success", line);
					if (line.startsWith("-")) return theme.fg("error", line);
					return theme.fg("dim", line);
				})
				.join("\n");
			const more = !expanded && allLines.length > 24 ? `\n${theme.fg("dim", `… (${allLines.length - 24} more)`)}` : "";
			return new Text(body + more, 0, 0);
		},

		async execute(toolCallId: string, params: Static<typeof editSchema>, signal: AbortSignal | undefined, onUpdate: any) {
			const state = getState();
			// hashline disabled by the user (config.enabled=false) → delegate to the built-in
			if (!state.config.enabled) return builtin.execute(toolCallId, params as any, signal, onUpdate);

			const path = params.path;
			const absPath = canonicalPath(cwd, path);

			if (!params.edits?.length) {
				return errResult(`Edit ${path}: \`edits\` is empty or missing.`);
			}
			// withFileMutationQueue serializes read-modify-write for the same file, preventing parallel-edit data loss
			return await withFileMutationQueue(absPath, () => runHashline(absPath, path, params.edits, signal));
		},
	};
}

async function runHashline(absPath: string, displayPath: string, editOps: readonly EditOpInput[], signal: AbortSignal | undefined) {
	const hashLen = getState().config.hashLen;

	let currentText: string;
	try {
		currentText = (await readFile(absPath)).toString("utf-8");
	} catch (e) {
		const msg = e instanceof Error ? e.message : String(e);
		return errResult(`Error reading ${displayPath}: ${msg}`);
	}
	// Check for cancel after read: if the user aborted, don't proceed to parse/apply; the file stays untouched
	if (signal?.aborted) return errResult(`Edit ${displayPath} aborted before apply.`);

	const translated = toCoreEdits(editOps);
	if (!translated.ok) return errResult(translated.error);

	// Anchors are verified against the current content. A line that changed (or a
	// hash the model didn't actually read) fails its own anchor — steering it to
	// read first. Unrelated changes elsewhere never block the edit.
	const result = applyEdits(currentText, translated.edits, hashLen);
	if (!result.ok) {
		return errResult(errorText(result.error, displayPath));
	}

	// Check for cancel before write: if aborted, don't touch the disk; the file stays untouched
	if (signal?.aborted) return errResult(`Edit ${displayPath} aborted before write.`);

	try {
		await writeFile(absPath, result.text);
	} catch (e) {
		const msg = e instanceof Error ? e.message : String(e);
		return errResult(`Error writing ${displayPath}: ${msg}`);
	}

	// pi's generateDiffString returns the display diff (colored by the renderer) and the first changed line
	const { diff, firstChangedLine } = generateDiffString(currentText, result.text);
	const details: EditToolDetails = {
		diff,
		patch: generateUnifiedPatch(displayPath, currentText, result.text),
		firstChangedLine,
	};
	const anchors = formatUpdatedAnchors(result.text, result.touchedLines, hashLen);
	return {
		content: [{ type: "text" as const, text: `Edited ${displayPath} (${translated.edits.length} op(s)).${anchors}` }],
		details,
	};
}
