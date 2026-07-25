/**
 * Override edit: hashline ops via structured `edits` (LINE#HASH anchors).
 *
 * Each op in `edits` references line anchors from the latest read; the core
 * apply verifies hashes. Legacy oldText/newText is not accepted — the schema
 * requires an `op` discriminator, so legacy payloads are rejected at the schema
 * layer (a visible failure, never a silent degradation).
 *
 * Concurrency safety: read-modify-write is wrapped in withFileMutationQueue.
 * AbortSignal is honored — checked after read / before write.
 *
 * @module pi-hashline-edit/pi
 */

import { createEditTool, generateDiffString, generateUnifiedPatch, withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { Text } from "@earendil-works/pi-tui";
import { readFile, writeFile } from "node:fs/promises";
import { applyEdits } from "../core/index.ts";
import type { Edit, FileSnapshot, PatchError } from "../core/types.ts";
import { canonicalPath } from "./read-tool.ts";
import { getState, getSnapshot, putSnapshot, recordSnapshot } from "./state.ts";

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
	edits: Type.Array(editOpSchema, { description: "Hashline ops, each referencing LINE#HASH anchors from your latest read" }),
});

type EditOpInput = Static<typeof editOpSchema>;

/** Turn a PatchError into helpful hint text for the model. */
function errorText(e: PatchError, path: string): string {
	switch (e.kind) {
		case "stale":
			return `File ${path} changed since your last read. Re-read it before editing.`;
		case "anchor":
			return `Anchor mismatch: ${e.message}. Re-read ${path} to get current line hashes (LINE#HASH).`;
		case "collision":
			return `Hash collision: ${e.message}. Re-read ${path}.`;
		case "range":
			return `Bad range: ${e.message}`;
		case "noop":
			return `Edit produced no change: ${e.message}`;
		case "parse":
			return `Parse error${e.line ? ` at line ${e.line}` : ""}: ${e.message}`;
	}
}

/** Get the first changed line after applying (for firstChangedLine / TUI jump). insert_after uses anchor + 1. */
function minAnchorLine(edits: readonly Edit[]): number | undefined {
	let min: number | undefined;
	for (const e of edits) {
		let line: number | undefined;
		if (e.op === "replace" || e.op === "delete") line = e.start.line;
		else if (e.op === "insert_after") line = e.anchor.line + 1;
		else if (e.op === "insert_before") line = e.anchor.line;
		else if (e.op === "prepend") line = 1;
		// append has no anchor, skip (trailing append)
		if (line !== undefined && (min === undefined || line < min)) min = line;
	}
	return min;
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

export function makeEditOverride(cwd: string) {
	const builtin = createEditTool(cwd);

	return {
		name: "edit" as const,
		label: "edit",
		description:
			"Edit a file via hashline ops (LINE#HASH anchors, content-verified). Each op in `edits` references line anchors from your latest read.",
		promptSnippet: "Edit files via hashline ops (edits[] with LINE#HASH anchors from read)",
		promptGuidelines: [
			"Pass `edits`: an array of ops. Each op = {op, anchor?, end?, body?}.",
			"op ∈ replace | delete | insert_after | insert_before | append | prepend.",
			"anchor & end = {line, hash} copied from your latest read (the `#HASH` after each line number). replace/delete take anchor (+ optional end for a range); insert_after/insert_before take anchor; append/prepend take neither.",
			"body = string[] of new content lines (required for replace/insert/append/prepend; omit for delete).",
			"After each successful edit, re-ground: line numbers shift, so take the next edit's anchors from a fresh read.",
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
	let currentText: string;
	try {
		currentText = (await readFile(absPath)).toString("utf-8");
	} catch (e) {
		const msg = e instanceof Error ? e.message : String(e);
		return errResult(`Error reading ${displayPath}: ${msg}`);
	}
	// Check for cancel after read: if the user aborted, don't proceed to parse/apply; the file stays untouched
	if (signal?.aborted) return errResult(`Edit ${displayPath} aborted before apply.`);

	// Use the recorded snapshot, or if there is none (the model didn't read) build one from the
	// current file — anchor verification still forces the model to use a real hash (it can't guess
	// correctly without reading), naturally steering it to read first.
	const snap: FileSnapshot = getSnapshot(absPath) ?? recordSnapshot(absPath, currentText);

	const translated = toCoreEdits(editOps);
	if (!translated.ok) return errResult(translated.error);

	const result = applyEdits(currentText, translated.edits, snap);
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

	// Update the snapshot: consecutive edits need no re-read (result.newSnapshot is based on the new text), via LRU
	putSnapshot(absPath, result.newSnapshot);

	return {
		content: [
			{ type: "text" as const, text: `Edited ${displayPath} (${translated.edits.length} op(s)).` },
		],
		details: {
			// details.diff must use pi's generateDiffString (+N content format) so the renderer colors it correctly
			diff: generateDiffString(currentText, result.text),
			patch: generateUnifiedPatch(displayPath, currentText, result.text),
			firstChangedLine: minAnchorLine(translated.edits),
		},
	};
}
