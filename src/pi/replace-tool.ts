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
import { readFile } from "node:fs/promises";
import { hashFileLines, splitLines } from "../core/index.ts";
import { createActionFusionExecutor, createThenRunSchema, type ThenRunInput } from "./action-fusion.ts";
import { commitFile, FileMutationError, type PublicationStatus } from "./file-commit.ts";
import { getState } from "./state.ts";
import { canonicalPath } from "./read-tool.ts";
import { formatDiffCounts, publishDiffCounts, renderDiffPreview, type DiffCounts } from "./render.ts";

/** Cap on updated-anchor lines returned inline (bounds token cost for large spans). */
const MAX_ANCHOR_LINES = 40;
/** Default safety cap on match count (errors before writing if exceeded). */
const DEFAULT_MAX_MATCHES = 2000;
/** Valid JavaScript regular-expression flag characters (ES2023+, incl. hasIndices `d`). */
const VALID_FLAGS = new Set(["g", "i", "m", "s", "u", "y", "d"]);

function createReplaceSchema(actionFusion: boolean) {
	return Type.Object({
		path: Type.String({ description: "Path to the file to edit (relative or absolute)" }),
		find: Type.String({ description: "Text to find. Literal substring when `regex` is false/omitted; a JavaScript regex pattern source when `regex` is true." }),
		replace: Type.String({ description: "Replacement text. Literal mode: inserted verbatim (no $ expansion). Regex mode: supports $1, $2, $&, $`, $' etc." }),
		regex: Type.Optional(Type.Boolean({ description: "Treat `find` as a JavaScript regex pattern source (default false = literal substring, all occurrences replaced)." })),
		flags: Type.Optional(Type.String({ description: "Regex flags appended in BOTH modes ('g' is always forced so every occurrence is replaced)." })),
		maxMatches: Type.Optional(Type.Number({ description: `Safety cap: errors before writing if more matches than this (default ${DEFAULT_MAX_MATCHES}). Raise for deliberate bulk transforms.` })),
		...(actionFusion ? { then_run: createThenRunSchema("Command to run after replace succeeds; failure does not roll back the replacement.") } : {}),
	});
}

const replaceSchema = createReplaceSchema(false);

type ReplaceParams = Omit<Static<typeof replaceSchema>, "then_run"> & { then_run?: ThenRunInput };

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

/** Call-header line: `replace path — mode "find" → "replace"`, plus `+N -N` once the result's diff counts are known. */
function replaceHeader(args: ReplaceParams, theme: any, counts?: DiffCounts): string {
	let t = theme.fg("toolTitle", theme.bold("replace "));
	t += theme.fg("accent", args.path);
	const mode = args.regex ? "regex" : "lit";
	const f = args.flags ? `/${args.flags}` : "";
	t += theme.fg("dim", ` — ${mode}${f} "${show(args.find)}" → "${show(args.replace)}"`);
	if (counts && (counts.added || counts.removed)) t += formatDiffCounts(counts, theme);
	return t;
}

export function makeReplaceTool(cwd: string, fusion?: ReturnType<typeof createActionFusionExecutor>): any {
	const parameters = createReplaceSchema(fusion !== undefined);
	return {
		name: "replace" as const,
		label: "replace",
		description:
			"Replace all matching text across a file. Supports literal strings and JavaScript regex; fails on zero matches. Returns a diff and fresh anchors.",
		promptSnippet: "Replace matching text across a file",
		promptGuidelines: [
			"Use replace for bulk changes; prefer edit for a specific, anchor-verified location.",
		],
		parameters,
		renderShell: "default" as const,

		renderCall(args: ReplaceParams & { then_run?: ThenRunInput }, theme: any, context: any) {
			const text = (context?.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			// Stash the header for renderResult: the diff counts land after
			// execution and are refreshed in place (renderResult's lastComponent
			// is the result component, not this header)
			if (context?.state) context.state.callText = text;
			text.setText(replaceHeader(args, theme, context?.state?.diffCounts));
			return text;
		},

		renderResult(result: any, { isPartial, expanded }: any, theme: any, context: any) {
			if (isPartial && result.details?.actionFusion?.publication !== "PUBLISHED") return new Text(theme.fg("warning", "Replacing…"), 0, 0);
			const content = result.content?.[0];
			if (context.isError) {
				const t = content?.type === "text" ? content.text.split("\n")[0] : "Error";
				return new Text(theme.fg("error", t), 0, 0);
			}
			const diff: string | undefined = result.details?.diff;
			// refresh the call header's +N -N in place — never invalidate from
			// inside a renderer (re-enters updateDisplay, diff renders twice)
			publishDiffCounts(diff, context, (counts) => {
				context.state?.callText?.setText(replaceHeader(context.args, theme, counts));
			});
			if (!diff) {
				// No net diff: show only the summary line — content.text also carries
				// `Updated anchors` (hashline) for the model.
				const summary = content?.type === "text" ? content.text.split("\n")[0] : "Replaced";
				return new Text(theme.fg("success", summary), 0, 0);
			}
			// details.diff is pi-format (+N/-N/<space>N content); renderDiff handles
			// semantic colors plus intra-line change highlighting
			const rendered = renderDiffPreview(diff, expanded, theme);
			return new Text(rendered, 0, 0);
		},

		async execute(toolCallId: string, params: ReplaceParams & { then_run?: ThenRunInput }, signal: AbortSignal | undefined, onUpdate: any, ctx: any) {
			const { then_run, ...mutationParams } = params;
			if (!fusion && then_run !== undefined) throw new Error("then_run is unavailable because hashlineEdit.actionFusion is disabled");
			const state = getState();
			const path = mutationParams.path;
			const absolutePath = canonicalPath(cwd, path);
			const mutate = () => withFileMutationQueue(absolutePath, () => runReplace(absolutePath, path, mutationParams, state.config.hashLen, signal));
			if (!fusion) return mutate();
			return fusion({ toolCallId, absolutePath, thenRun: then_run, mutate, signal, ctx, onUpdate });
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

	let publication: PublicationStatus = "NOT_PUBLISHED";
	if (changed) {
		try {
			publication = (await commitFile(absPath, newText, { mode: "overwrite", signal })).publication;
		} catch (e) {
			if (e instanceof FileMutationError) throw e;
			throw new FileMutationError("commit", "UNKNOWN", `Error writing ${displayPath}: ${e instanceof Error ? e.message : String(e)}`, { cause: e });
		}
	}

	let details: EditToolDetails & { publication: PublicationStatus };
	let anchors: string;
	let note: string;
	try {
		// diff、anchors 和结果文本属于发布后的后处理；失败时保留 publication。
		const oldLf = currentText.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
		const newLf = newText.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
		const { diff, firstChangedLine } = generateDiffString(oldLf, newLf);
		details = {
			diff,
			patch: generateUnifiedPatch(displayPath, oldLf, newLf),
			firstChangedLine,
			publication,
		};
		const oldLines = splitLines(currentText);
		const newLines = splitLines(newText);
		const span = changed ? changedSpan(oldLines, newLines) : null;
		anchors = span ? formatSpanAnchors(newLines, span, hashLen) : "";
		const matchWord = `match${count !== 1 ? "es" : ""}`;
		note = changed ? `${count} ${matchWord}` : `${count} ${matchWord}, no net change`;
	} catch (error) {
		throw new FileMutationError("post_process", publication, `file was published but replace result generation failed: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
	}
	return {
		content: [{ type: "text" as const, text: `Replaced ${displayPath} (${note}).${anchors}` }],
		details,
	};
}
