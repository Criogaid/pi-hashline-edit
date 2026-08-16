/**
 * `replace`: powerful bulk text replacement — literal substring (replaceAll) or
 * full JavaScript regex with capture-group substitution.
 *
 * Distinct from the anchor-verified `edit`. `replace` is **location-blind**:
 * it matches `find` everywhere across the whole file and substitutes every
 * occurrence. Use it for renames and pattern-based transforms that would
 * otherwise need many individual edits. For a single surgical, verified change,
 * prefer `edit`.
 *
 * - Literal mode (`regex` false): `find` is a substring, matched verbatim;
 *   `replace` is inserted as-is (no `$` expansion).
 * - Regex mode (`regex` true): `find` is a JS pattern source; `replace` supports
 *   `$1`, `$2`, `$&`, etc.
 * - `flags` adds regex flags in either mode; `g` is always forced so every
 *   occurrence is replaced. `i` (case-insensitive), `m` (per-line ^/$),
 *   `s` (dotall), `u` (unicode) all work.
 *
 * Concurrency: read-modify-write is wrapped in {@link withFileMutationQueue}
 * (shared with `edit`), so a `replace` and an `edit` on the same file never
 * interleave. AbortSignal is honored after read / before write.
 *
 * @module pi-hashline-edit/pi
 */

import {
	generateDiffString,
	generateUnifiedPatch,
	withFileMutationQueue,
	type EditToolDetails,
} from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { Text } from "@earendil-works/pi-tui";
import { readFile, writeFile } from "node:fs/promises";
import { hashFileLines, splitLines } from "../core/index.ts";
import { getState } from "./state.ts";
import { canonicalPath } from "./read-tool.ts";
import { renderDiffPreview } from "./render.ts";

/** Cap on updated-anchor lines returned inline (bounds token cost for large spans). */
const MAX_ANCHOR_LINES = 40;
/** Default safety cap on match count (errors before writing if exceeded). */
const DEFAULT_MAX_MATCHES = 2000;
/** Valid JavaScript regular-expression flag characters (ES2023+, incl. hasIndices `d`). */
const VALID_FLAGS = new Set(["g", "i", "m", "s", "u", "y", "d"]);

const replaceSchema = Type.Object({
	path: Type.String({ description: "Path to the file to edit (relative or absolute)" }),
	find: Type.String({
		description:
			"Text to find. Literal substring when `regex` is false/omitted; a JavaScript regex pattern source when `regex` is true.",
	}),
	replace: Type.String({
		description:
			"Replacement text. Literal mode: inserted verbatim (no $ expansion). Regex mode: supports $1, $2, $&, $`, $' etc.",
	}),
	regex: Type.Optional(
		Type.Boolean({
			description:
				"Treat `find` as a JavaScript regex pattern source (default false = literal substring, all occurrences replaced).",
		}),
	),
	flags: Type.Optional(
		Type.String({
			description:
				"Regex flags appended in BOTH modes ('g' is always forced so every occurrence is replaced). Default ''. Common: 'i' (case-insensitive), 'm' (^/$ per line), 's' (dotall, . matches \\n), 'u' (unicode).",
		}),
	),
	maxMatches: Type.Optional(
		Type.Number({
			description: `Safety cap: errors before writing if more matches than this (default ${DEFAULT_MAX_MATCHES}). Raise for deliberate bulk transforms.`,
		}),
	),
});

type ReplaceParams = Static<typeof replaceSchema>;

/** Escape regex metacharacters so a literal string is matched verbatim. */
function escapeRegex(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Build the matcher. `find` is escaped in literal mode; `flags` (validated) get
 * `g` forced so all occurrences replace. Construction errors (bad pattern /
 * conflicting flags such as `g`+`y`) surface as a friendly message rather than
 * a raw `SyntaxError`.
 */
function buildRegex(find: string, isRegex: boolean, flagsRaw: string | undefined): RegExp {
	for (const c of flagsRaw ?? "") {
		if (!VALID_FLAGS.has(c)) throw new Error(`invalid regex flag '${c}' (valid: g i m s u y d)`);
	}
	const set = new Set((flagsRaw ?? "").split(""));
	set.add("g");
	const flagStr = [...set].join("");
	const source = isRegex ? find : escapeRegex(find);
	try {
		return new RegExp(source, flagStr);
	} catch (e) {
		const msg = e instanceof Error ? e.message : String(e);
		throw new Error(`invalid regex /${source}/${flagStr}: ${msg}`);
	}
}

/**
 * First-to-last differing line span (0-based, inclusive) in the NEW line array —
 * a contiguous superset that contains every changed line. Computed by stripping
 * the common prefix and suffix, so it is O(n) regardless of file size (no LCS
 * DP). `null` when the text is unchanged. Used only to bound the anchor report.
 */
function changedSpan(oldLines: readonly string[], newLines: readonly string[]): { start: number; end: number } | null {
	const n = Math.min(oldLines.length, newLines.length);
	let prefix = 0;
	while (prefix < n && oldLines[prefix] === newLines[prefix]) prefix++;
	// same length and fully equal → no change
	if (oldLines.length === newLines.length && prefix === oldLines.length) return null;
	let oldSuffix = 0;
	let newSuffix = 0;
	while (
		oldSuffix < oldLines.length - prefix &&
		newSuffix < newLines.length - prefix &&
		oldLines[oldLines.length - 1 - oldSuffix] === newLines[newLines.length - 1 - newSuffix]
	) {
		oldSuffix++;
		newSuffix++;
	}
	const start = prefix;
	const end = newLines.length - 1 - newSuffix; // inclusive, 0-based, in new
	return end < start ? null : { start, end };
}

/** Format fresh `LINE#HASH│content` anchors for a contiguous span of the new file, capped. */
function formatSpanAnchors(newLines: readonly string[], span: { start: number; end: number }, hashLen: number): string {
	const hashes = hashFileLines(newLines, hashLen);
	const rows: string[] = [];
	for (let i = span.start; i <= span.end; i++) rows.push(`${i + 1}#${hashes[i]}│${newLines[i]}`);
	const shown = rows.length > MAX_ANCHOR_LINES ? rows.slice(0, MAX_ANCHOR_LINES) : rows;
	const more = rows.length > MAX_ANCHOR_LINES ? `\n… (${rows.length - MAX_ANCHOR_LINES} more; re-read for full anchors)` : "";
	return `\nUpdated anchors (changed region):\n${shown.join("\n")}${more}`;
}

/** Truncate a string for one-line display, folding newlines into a marker. */
function show(s: string, n = 30): string {
	const folded = s.replace(/\n/g, "⏎");
	return folded.length > n ? folded.slice(0, n) + "…" : folded;
}

export function makeReplaceTool(cwd: string) {
	return {
		name: "replace" as const,
		label: "replace",
		description:
			"Bulk text replacement with regex support. Replaces ALL occurrences of `find` with `replace` across the whole file — for renames and pattern-based transforms that would need many individual edits. Location-blind (unverified): prefer `edit` for surgical, anchor-verified changes.",
		promptSnippet: "Replace all occurrences of a string/regex across a file (bulk + regex; returns diff and fresh anchors)",
		promptGuidelines: [
			"Pass `path`, `find`, `replace`. ALL occurrences are replaced (not just the first).",
			"`regex: true` treats `find` as a JS regex pattern; capture groups are usable in `replace` via $1, $2, $&. Default false = literal substring (replace text inserted verbatim, no $ expansion).",
			"`flags` adds regex flags ('g' is always forced so every occurrence is replaced). Common: 'i' (case-insensitive), 'm' (^/$ per line), 's' (dotall, . matches \\n), 'u' (unicode). Applies in both modes.",
			"`maxMatches` caps the match count (default 2000) — errors before writing if exceeded; raise it for deliberate bulk transforms.",
			"Returns a diff plus fresh anchors for the changed region; chain edits, or re-read if you need the whole file's anchors.",
			"0 matches is an error. This is a location-blind bulk tool — for one verified change use `edit` instead.",
		],
		parameters: replaceSchema,
		renderShell: "default" as const,

		renderCall(args: ReplaceParams, theme: any) {
			let text = theme.fg("toolTitle", theme.bold("replace "));
			text += theme.fg("accent", args.path);
			const mode = args.regex ? "regex" : "lit";
			const f = args.flags ? `/${args.flags}` : "";
			text += theme.fg("dim", ` — ${mode}${f} "${show(args.find)}" → "${show(args.replace)}"`);
			return new Text(text, 0, 0);
		},

		renderResult(result: any, { isPartial, expanded }: any, theme: any, context: any) {
			if (isPartial) return new Text(theme.fg("warning", "Replacing…"), 0, 0);
			const content = result.content?.[0];
			if (context.isError) {
				const t = content?.type === "text" ? content.text.split("\n")[0] : "Error";
				return new Text(theme.fg("error", t), 0, 0);
			}
			const diff: string | undefined = result.details?.diff;
			if (!diff) {
				// No net diff: show only the summary line — content.text also carries
				// `Updated anchors` (hashline) for the model.
				const t = content?.type === "text" ? content.text.split("\n")[0] : "Replaced";
				return new Text(theme.fg("success", t), 0, 0);
			}
			// details.diff is pi-format (+N/-N/<space>N content); renderDiff handles
			// semantic colors plus intra-line change highlighting
			return new Text(renderDiffPreview(diff, expanded, theme), 0, 0);
		},

		async execute(toolCallId: string, params: ReplaceParams, signal: AbortSignal | undefined, onUpdate: any) {
			const state = getState();
			// Gated by the same `enabled` switch as read/grep/edit — they delegate to the
			// built-ins when disabled; replace has no built-in counterpart, so it refuses.
			if (!state.config.enabled)
				throw new Error(
					"Replace is unavailable: hashlineEdit is disabled. Set hashlineEdit.enabled = true to use it.",
				);
			const path = params.path;
			const absPath = canonicalPath(cwd, path);

			// withFileMutationQueue serializes read-modify-write for the same file,
			// shared with `edit` — a replace and an edit on the same file never interleave.
			return await withFileMutationQueue(absPath, () => runReplace(absPath, path, params, state.config.hashLen, signal));
		},
	};
}

async function runReplace(
	absPath: string,
	displayPath: string,
	params: ReplaceParams,
	hashLen: number,
	signal: AbortSignal | undefined,
) {
	const { find, replace } = params;
	const isRegex = params.regex === true;
	const maxMatches = params.maxMatches ?? DEFAULT_MAX_MATCHES;

	if (find === "") throw new Error(`Replace ${displayPath}: \`find\` is empty.`);

	let currentText: string;
	try {
		currentText = (await readFile(absPath)).toString("utf-8");
	} catch (e) {
		const msg = e instanceof Error ? e.message : String(e);
		throw new Error(`Error reading ${displayPath}: ${msg}`);
	}
	// honor cancel after read: if aborted, don't proceed to match/replace; the file stays untouched
	if (signal?.aborted) throw new Error(`Replace ${displayPath} aborted before apply.`);

	let regex: RegExp;
	try {
		regex = buildRegex(find, isRegex, params.flags);
	} catch (e) {
		throw new Error(`Replace ${displayPath}: ${e instanceof Error ? e.message : String(e)}`);
	}

	// Count matches with an early guard so a runaway pattern (e.g. an empty-match
	// regex) can't produce a catastrophic write. matchAll does not mutate the
	// regex's lastIndex (it clones internally), so the subsequent `replace` is safe.
	let count = 0;
	for (const _ of currentText.matchAll(regex)) {
		count++;
		if (count > maxMatches) {
			throw new Error(
				`Replace ${displayPath}: ${count}+ matches exceed \`maxMatches\` (${maxMatches}). Raise \`maxMatches\` if intentional, or narrow \`find\`.`,
			);
		}
	}
	if (count === 0) {
		const shown = isRegex ? `/${find}/` : JSON.stringify(find);
		throw new Error(`Replace ${displayPath}: no matches for ${shown}.`);
	}

	// Literal mode uses a function replacement so `$` in `replace` stays literal;
	// regex mode passes the string so $1/$& etc. expand.
	// Literal mode uses a function replacement so `$` in `replace` stays literal;
	// regex mode passes the string so $1/$& etc. expand.
	const newText = isRegex ? currentText.replace(regex, replace) : currentText.replace(regex, () => replace);
	const changed = newText !== currentText;

	// honor cancel before write: if aborted, don't touch the disk
	if (signal?.aborted) throw new Error(`Replace ${displayPath} aborted before write.`);

	if (changed) {
		try {
			await writeFile(absPath, newText);
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			throw new Error(`Error writing ${displayPath}: ${msg}`);
		}
	}

	// generateDiffString / generateUnifiedPatch split on \n, so raw CRLF content would
	// leave a trailing \r on every diff line — the TUI line-wrapper (wrapTextWithAnsi)
	// then emits a spurious blank line per diff line. Normalize to LF for diff/patch
	// only; the disk write above already preserved the original line endings.
	const oldLf = currentText.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
	const newLf = newText.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
	const { diff, firstChangedLine } = generateDiffString(oldLf, newLf);
	const details: EditToolDetails = {
		diff,
		patch: generateUnifiedPatch(displayPath, oldLf, newLf),
		firstChangedLine,
	};

	const oldLines = splitLines(currentText);
	const newLines = splitLines(newText);
	const span = changed ? changedSpan(oldLines, newLines) : null;
	const anchors = span ? formatSpanAnchors(newLines, span, hashLen) : "";

	const matchWord = `match${count !== 1 ? "es" : ""}`;
	const note = changed ? `${count} ${matchWord}` : `${count} ${matchWord}, no net change`;
	return {
		content: [{ type: "text" as const, text: `Replaced ${displayPath} (${note}).${anchors}` }],
		details,
	};
}
