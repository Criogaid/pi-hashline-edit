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
 * - `replacements` batches rules against one original snapshot; conflicting
 *   ranges or a failing rule reject the entire batch before publication.
 *
 * Concurrency: read-modify-write is wrapped in {@link withFileMutationQueue}
 * (shared with `edit`), so a `replace` and an `edit` on the same file never
 * interleave. AbortSignal is honored after read / before write.
 *
 * @module pi-hashline-edit/pi
 */

import {
	withFileMutationQueue,
} from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { escapeRegex } from "../core/text.ts";
import { splitLines } from "../core/index.ts";
import { findSortedRangeConflict } from "../core/ranges.ts";
import { ACTION_FUSION_GUIDELINES, createActionFusionExecutor, createThenRunSchema, type ThenRunInput } from "./action-fusion.ts";
import { readEditableSnapshot, commitReplacement } from "./file-commit.ts";
import { createAnchorFormatter, type AnchorFormatter } from "./anchor-format.ts";
import { canonicalPath } from "./read-tool.ts";
import { formatDiffCounts, renderMutationCall, renderMutationResult, type DiffCounts } from "./render.ts";
import { appendMutationAnchors, finalizeMutationResult, formatMutationAnchors, generateMutationDetails, postProcessMutation } from "./mutation-result.ts";

/** Default safety cap on match count (errors before writing if exceeded). */
const DEFAULT_MAX_MATCHES = 2000;
/** Valid JavaScript regular-expression flag characters (ES2023+, incl. hasIndices `d`). */
const VALID_FLAGS = new Set(["g", "i", "m", "s", "u", "y", "d"]);

const replacementSchema = Type.Object({
	find: Type.String({ description: "Text to find. Literal substring by default; a JavaScript regex source when regex is true." }),
	replace: Type.String({ description: "Replacement text. Literal mode inserts verbatim; regex mode supports JavaScript $ substitutions." }),
	regex: Type.Optional(Type.Boolean({ description: "Interpret find as a JavaScript regex (default false)." })),
	flags: Type.Optional(Type.String({ description: "Regex flags in either mode; g is always added." })),
	maxMatches: Type.Optional(Type.Number({ exclusiveMinimum: 0, description: `Per-rule match cap (default ${DEFAULT_MAX_MATCHES}); exceeding it rejects the entire call.` })),
});
type Replacement = Static<typeof replacementSchema>;

function createReplaceSchema(actionFusion: boolean) {
	return Type.Object({
		path: Type.String({ description: "Path to the file to edit (relative or absolute)" }),
		...Type.Partial(replacementSchema).properties,
		replacements: Type.Optional(Type.Array(replacementSchema, { minItems: 1, description: "Rules matched against one original snapshot. Mutually exclusive with top-level find/replace/regex/flags/maxMatches. Overlaps reject the entire batch." })),
		...(actionFusion ? { then_run: createThenRunSchema("Command to run once after all replacements succeed; failure does not roll back the replacement.") } : {}),
	});
}

const replaceSchema = createReplaceSchema(false);
type ReplaceParams = Omit<Static<typeof replaceSchema>, "then_run"> & { then_run?: ThenRunInput };

function replacementRules(params: ReplaceParams): Replacement[] {
	if (params.replacements !== undefined && Object.keys(replacementSchema.properties).some((key) => params[key as keyof Replacement] !== undefined)) {
		throw new Error("replacements cannot be combined with top-level replacement fields");
	}
	const rules = params.replacements ?? [params];
	if (!Array.isArray(rules) || rules.length === 0) throw new Error("replacements must be a non-empty array");
	for (const [index, rule] of rules.entries()) {
		if (!rule || typeof rule.find !== "string" || typeof rule.replace !== "string") throw new Error(`rule ${index}: find and replace must be strings`);
		if (rule.find === "") throw new Error(`rule ${index}: \`find\` is empty`);
		if (rule.regex !== undefined && typeof rule.regex !== "boolean") throw new Error(`rule ${index}: regex must be a boolean`);
		if (rule.flags !== undefined && typeof rule.flags !== "string") throw new Error(`rule ${index}: flags must be a string`);
		if (rule.maxMatches !== undefined && (!Number.isFinite(rule.maxMatches) || rule.maxMatches <= 0)) throw new Error(`rule ${index}: maxMatches must be finite and positive`);
	}
	return rules as Replacement[];
}

/**
 * Build the matcher. `find` is escaped in literal mode; `flags` (validated) get
 * `g` forced so all occurrences replace. Invalid patterns or unsupported flags
 * surface as a friendly message rather than a raw `SyntaxError`.
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

/** Expand JS replacement tokens against the original match, including prefix/suffix context. */
function expandReplacement(template: string, match: RegExpMatchArray, source: string): string {
	// Without named captures, $<...> is ordinary text and may contain other $ tokens.
	const tokens = match.groups === undefined ? /\$(\$|&|`|'|\d{1,2})/g : /\$(\$|&|`|'|<[^>]*>|\d{1,2})/g;
	return template.replace(tokens, (token, key: string) => {
		if (key === "$") return "$";
		if (key === "&") return match[0];
		if (key === "`") return source.slice(0, match.index);
		if (key === "'") return source.slice(match.index! + match[0].length);
		if (key.startsWith("<")) return match.groups === undefined ? token : (match.groups[key.slice(1, -1)] ?? "");
		const index = Number(key);
		if (index > 0 && index < match.length) return match[index] ?? "";
		// $12 falls back to capture 1 plus literal 2 when capture 12 does not exist.
		const first = Number(key[0]);
		if (key.length === 2 && first > 0 && first < match.length) return (match[first] ?? "") + key[1];
		return token;
	});
}

function applyReplacements(source: string, rules: readonly Replacement[]): { text: string; count: number } {
	const changes: { start: number; end: number; text: string; rule: number }[] = [];
	for (const [index, rule] of rules.entries()) {
		try {
			const regex = buildRegex(rule.find, rule.regex === true, rule.flags);
			const maxMatches = rule.maxMatches ?? DEFAULT_MAX_MATCHES;
			let count = 0;
			for (const match of source.matchAll(regex)) {
				if (++count > maxMatches) throw new Error(`${count}+ matches exceed \`maxMatches\` (${maxMatches}). Raise \`maxMatches\` if intentional, or narrow \`find\`.`);
				changes.push({
					start: match.index!, end: match.index! + match[0].length, rule: index,
					text: rule.regex ? expandReplacement(rule.replace, match, source) : rule.replace,
				});
			}
			if (count === 0) throw new Error(`no matches for ${rule.regex ? `/${rule.find}/` : JSON.stringify(rule.find)}.`);
		} catch (error) {
			throw new Error(`rule ${index}: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	changes.sort((a, b) => a.start - b.start || a.end - b.end);
	const conflict = findSortedRangeConflict(changes.map((change) => [change.start, change.end]));
	if (conflict !== undefined) {
		const previous = changes[conflict - 1];
		const current = changes[conflict];
		throw new Error(`rules ${previous.rule} and ${current.rule} overlap at offset ${current.start}; no replacements applied`);
	}
	const parts: string[] = [];
	let cursor = 0;
	for (const change of changes) {
		parts.push(source.slice(cursor, change.start), change.text);
		cursor = change.end;
	}
	parts.push(source.slice(cursor));
	return { text: parts.join(""), count: changes.length };
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
function formatSpanAnchors(newLines: readonly string[], span: { start: number; end: number }, anchors: AnchorFormatter): string {
	function* indices() {
		for (let i = span.start; i <= span.end; i++) yield i;
	}
	return formatMutationAnchors(newLines, indices(), anchors, "Updated anchors (changed region):");
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
	if (args.replacements) {
		t += theme.fg("dim", ` — ${args.replacements.length} rules`);
	} else {
		const mode = args.regex ? "regex" : "lit";
		const f = args.flags ? `/${args.flags}` : "";
		t += theme.fg("dim", ` — ${mode}${f} "${show(args.find ?? "")}" → "${show(args.replace ?? "")}"`);
	}
	if (counts && (counts.added || counts.removed)) t += formatDiffCounts(counts, theme);
	return t;
}

export function makeReplaceTool(cwd: string, fusion?: ReturnType<typeof createActionFusionExecutor>): any {
	const parameters = createReplaceSchema(fusion !== undefined);
	return {
		name: "replace" as const,
		label: "replace",
		description:
			"Replace all matching text across a file with one rule or a replacements batch. All rules match the original snapshot; overlaps or any zero-match rule reject the entire call. Supports literal strings and JavaScript regex. Returns a diff and fresh anchors.",
		promptSnippet: "Replace matching text across a file",
		promptGuidelines: [
			"Use replace for bulk changes; prefer edit for a specific, anchor-verified location.",
			...(fusion ? ACTION_FUSION_GUIDELINES : []),
		],
		parameters,
		renderShell: "default" as const,

		renderCall(args: ReplaceParams & { then_run?: ThenRunInput }, theme: any, context: any) {
			return renderMutationCall(args, theme, context, replaceHeader);
		},

		renderResult(result: any, options: any, theme: any, context: any) {
			return renderMutationResult(result, options, theme, context, "Replacing…", "Replaced", replaceHeader);
		},

		async execute(toolCallId: string, params: ReplaceParams & { then_run?: ThenRunInput }, signal: AbortSignal | undefined, onUpdate: any, ctx: any) {
			const { then_run, ...mutationParams } = params;
			if (!fusion && then_run !== undefined) throw new Error("then_run is unavailable because hashlineEdit.actionFusion is disabled");
			const path = mutationParams.path;
			const absolutePath = canonicalPath(cwd, path);
			let mutationAnchors = "";
			const mutate = () => withFileMutationQueue(absolutePath, () => runReplace(absolutePath, path, mutationParams, signal, (value) => { mutationAnchors = value; }));
			const finalizeMutation = (result: any, publishAnchors: boolean) => appendMutationAnchors(result, mutationAnchors, publishAnchors);
			if (!fusion) return finalizeMutationResult(await mutate(), finalizeMutation);
			return fusion({ toolCallId, absolutePath, thenRun: then_run, mutate, finalizeMutation, signal, ctx, onUpdate });
		},
	};
}

async function runReplace(
	absPath: string,
	displayPath: string,
	params: ReplaceParams,
	signal: AbortSignal | undefined,
	onAnchors: (anchors: string) => void,
) {
	const anchorFormatter = createAnchorFormatter();
	let rules: Replacement[];
	try { rules = replacementRules(params); } catch (error) {
		throw new Error(`Replace ${displayPath}: ${error instanceof Error ? error.message : String(error)}`);
	}

	const { text: currentText, baseRevision } = await readEditableSnapshot(absPath, displayPath);
	// honor cancel after read: if aborted, don't proceed to match/replace; the file stays untouched
	if (signal?.aborted) throw new Error(`Replace ${displayPath} aborted before apply.`);

	let newText: string;
	let count: number;
	try {
		({ text: newText, count } = applyReplacements(currentText, rules));
	} catch (error) {
		throw new Error(`Replace ${displayPath}: ${error instanceof Error ? error.message : String(error)}`);
	}
	const changed = newText !== currentText;

	// honor cancel before write: if aborted, don't touch the disk
	if (signal?.aborted) throw new Error(`Replace ${displayPath} aborted before write.`);

	const versions = await commitReplacement(absPath, displayPath, newText, baseRevision, signal);
	const { publication } = versions;

	return postProcessMutation("replace", publication, () => {
		const details = generateMutationDetails(displayPath, currentText, newText, versions, publication);
		const newLines = splitLines(newText);
		const span = changed ? changedSpan(splitLines(currentText), newLines) : null;
		onAnchors(span ? formatSpanAnchors(newLines, span, anchorFormatter) : "");
		const matchWord = `match${count !== 1 ? "es" : ""}`;
		const note = changed ? `${count} ${matchWord}` : `${count} ${matchWord}, no net change`;
		return {
			content: [{ type: "text" as const, text: `Replaced ${displayPath} (${note}).` }],
			details,
		};
	});
}
