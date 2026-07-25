/**
 * Override edit: accepts only a hashline patch (`input`).
 *
 * Not backward-compatible with legacy oldText/newText — when legacy input is
 * detected it errors explicitly so the developer knows the model didn't use the
 * new approach, rather than silently degrading. Tolerance is limited to
 * format-only normalizations that don't affect the result (optional colon, CRLF
 * at the parse layer); paradigm-level compatibility is refused outright.
 *
 * Concurrency safety: the read-modify-write is wrapped in
 * withFileMutationQueue, serializing multiple edits to the same file to prevent
 * data loss under pi's default parallel execution. AbortSignal is honored —
 * checked after read / before write, so a user cancel never touches the disk.
 *
 * @module pi-hashline-edit/pi
 */

import { createEditTool, generateDiffString, generateUnifiedPatch, withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { readFile, writeFile } from "node:fs/promises";
import { applyEdits, parsePatch } from "../core/index.ts";
import type { Edit, FileSnapshot, PatchError } from "../core/types.ts";
import { canonicalPath } from "./read-tool.ts";
import { getState, getSnapshot, putSnapshot, recordSnapshot } from "./state.ts";
import { Text } from "@earendil-works/pi-tui";

// The schema deliberately omits additionalProperties:false: when the model
// mistakenly sends legacy edits/oldText/newText, those extra fields reach
// execute as-is and are caught and rejected explicitly by missingInputError.
// This relies on typebox allowing extra properties by default + pi validation
// not stripping them — do not change either of these.

const editSchema = Type.Object({
	path: Type.String({ description: "Path to the file to edit (relative or absolute)" }),
	input: Type.Optional(
		Type.String({
			description:
				"Hashline patch referencing LINE#HASH anchors from your latest read. Ops: replace / delete / insert_after / insert_before / append / prepend. Body rows start with `+`. This tool does NOT accept legacy oldText/newText.",
		}),
	),
});

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

/**
 * The model didn't use hashline (sent legacy oldText/newText or is missing
 * input) → tell it explicitly, don't silently degrade. Exported for testing.
 * params is `any` so it can detect legacy fields outside the schema.
 */
export function missingInputError(path: string, params: any): string {
	const legacy =
		Array.isArray(params?.edits) ||
		typeof params?.oldText === "string" ||
		typeof params?.newText === "string";
	if (legacy) {
		return `⚠ ${path}: you sent the legacy oldText/newText format, but this edit tool ONLY accepts hashline \`input\`. The legacy path was intentionally removed so this is surfaced, not silently degraded. Re-read ${path} to get LINE#HASH anchors, then send \`input\` (e.g. \`replace 4#aF3:\` followed by \`+\` body rows).`;
	}
	return `Edit ${path}: missing \`input\` (hashline patch). Read ${path} first, then send \`input\` referencing LINE#HASH anchors.`;
}

/** Build an error result (with isError: true so the TUI/agent loop treats it as a failure, not a success). */
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
			"Edit a file via hashline patch (LINE#HASH anchors, content-verified). Does NOT accept legacy oldText/newText.",
		promptSnippet: "Edit files via hashline LINE#HASH anchors (input patch); legacy oldText/newText not accepted",
		promptGuidelines: [
			"Pass `input`: a hashline patch referencing `LINE#HASH` anchors copied from your latest read output (e.g. `replace 12#aF3:`).",
			"Ops: `replace LINE#HASH[..LINE#HASH]:` · `delete LINE#HASH` · `insert_after LINE#HASH:` · `insert_before LINE#HASH:` · `append:` · `prepend:`.",
			"Body rows start with `+` followed by the literal line. `+` alone = blank line. Literal `+`/`-` lines become `++`/`+-`.",
			"After each successful edit, re-ground: line numbers shift, so take the next edit's anchors from a fresh read.",
			"This tool does NOT accept legacy oldText/newText — sending those returns an error (intentional, so it's visible).",
		],
		parameters: editSchema,
		renderShell: "self" as const,

		renderCall(args: Static<typeof editSchema>, theme: any) {
			let text = theme.fg("toolTitle", theme.bold("edit "));
			text += theme.fg("accent", args.path);
			if (args.input) {
				const firstOp = args.input.split("\n").find((l) => l.trim() && !l.startsWith("+"));
				if (firstOp) text += theme.fg("dim", ` — ${firstOp.trim()}`);
			}
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
			const input = params.input;

			// No input → tell explicitly (distinguish legacy vs missing), don't silently degrade
			if (typeof input !== "string" || input.trim() === "") {
				return errResult(missingInputError(path, params as any));
			}
			// withFileMutationQueue serializes read-modify-write for the same file, preventing parallel-edit data loss
			return await withFileMutationQueue(absPath, () => runHashline(absPath, path, input, signal));
		},
	};
}

async function runHashline(absPath: string, displayPath: string, input: string, signal: AbortSignal | undefined) {
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

	// input has no file header; prepend one so parsePatch passes (path is just a label)
	const parsed = parsePatch(`file: ${absPath}\n\n${input}`);
	if (!parsed.ok) {
		return errResult(errorText(parsed.error, displayPath));
	}

	const result = applyEdits(currentText, parsed.patch.edits, snap);
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
			{ type: "text" as const, text: `Edited ${displayPath} (${parsed.patch.edits.length} op(s)).` },
		],
		details: {
			// details.diff must use pi's generateDiffString (+N content format); the built-in
			// renderer's parseDiffLine only recognizes this format — core's standard unified diff
			// would be grayed out as plain text
			diff: generateDiffString(currentText, result.text),
			patch: generateUnifiedPatch(displayPath, currentText, result.text),
			firstChangedLine: minAnchorLine(parsed.patch.edits),
		},
	};
}
