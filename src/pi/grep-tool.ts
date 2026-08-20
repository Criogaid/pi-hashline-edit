/**
 * Override grep: search results carry `LINE#HASH│` anchors (same format as
 * read), grouped by file. The model can copy `LINE#HASH` straight into an edit
 * anchor — no re-read needed. Context lines (`context`) are anchored too.
 *
 * Beyond the built-in grep it covers the compound queries models otherwise
 * drop to bash pipelines for: multi-pattern AND (`matchMode: "all"` ≈
 * `grep A | grep B`), line exclusion (`excludePattern` ≈ `grep -v`),
 * whole-word matching (`wordMatch` ≈ `-w`), multiple search roots, and
 * files-only / count output (`outputMode` ≈ `rg -l` / `grep -c`).
 *
 * We run ripgrep directly (`--json`) rather than wrap the built-in grep, so we
 * control formatting and can compute each line's hash from its FULL content
 * while displaying a truncated copy. (The built-in grep truncates long lines
 * before formatting; hashing that truncated text would not match what edit
 * verifies against the full line — so the hash must be computed from the full
 * content, independently of what is displayed.)
 *
 * Filters run in two places: rg gets every pattern as `-e` (native OR) plus
 * the global flags; the AND / exclude checks then run client-side on each
 * matched line's text (streamed by rg), so `limit` counts final results, not
 * pre-filter candidates. Context windows are likewise rebuilt client-side from
 * the surviving matches — context lines of a filtered-out match never leak.
 *
 * Falls back to the built-in grep when: hashline disabled with plain params,
 * aborted, or ripgrep cannot be located (the built-in can auto-download rg).
 * Extended params never delegate — the built-in would misread them.
 *
 * @module pi-hashline-edit/pi
 */

import {
	getAgentDir,
	createGrepTool,
	truncateHead,
	truncateLine,
	formatSize,
	DEFAULT_MAX_BYTES,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Text } from "@earendil-works/pi-tui";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { access, constants, readFile, stat } from "node:fs/promises";
import { basename, delimiter, join, relative } from "node:path";
import { hashFileLines } from "../core/hash.ts";
import { splitLines } from "../core/lines.ts";
import { getState } from "./state.ts";
import { canonicalPath } from "./read-tool.ts";
import { parseHashline } from "./render.ts";

const DEFAULT_LIMIT = 100;
/** Max chars per result line for display (mirrors pi's truncate.ts; not exported there). */
const GREP_MAX_LINE_LENGTH = 500;

/** Locate ripgrep: pi's bundled bin first, then PATH. Returns null if not found. */
async function findRg(): Promise<string | null> {
	const agentDir = getAgentDir();
	const piRg = join(agentDir, "bin", "rg");
	try {
		await access(piRg, constants.X_OK);
		return piRg;
	} catch {}
	for (const dir of process.env.PATH?.split(delimiter) ?? []) {
		if (!dir) continue;
		const p = join(dir, "rg");
		try {
			await access(p, constants.X_OK);
			return p;
		} catch {}
	}
	return null;
}

/** Escape a literal string for use as a regex source. */
function escapeRegex(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Compile a pattern for the client-side line checks (`matchMode: "all"` and
 * `excludePattern`), mirroring the flags rg was given — `literal`,
 * `ignoreCase`, and (for the AND check) `wordMatch` — so a line rg accepted is
 * judged by the same semantics here. Patterns valid in rg but invalid as a JS
 * regex (e.g. `(?P<name>…)`) throw rather than silently degrade.
 */
function compileLineMatcher(
	pattern: string,
	opts: { literal: boolean; ignoreCase: boolean; word: boolean },
): RegExp {
	let source = opts.literal ? escapeRegex(pattern) : pattern;
	if (opts.word) source = `\\b(?:${source})\\b`;
	const flags = opts.ignoreCase ? "i" : "";
	try {
		return new RegExp(source, flags);
	} catch (err) {
		throw new Error(`Pattern not supported for line filtering: ${pattern} (${(err as Error).message})`);
	}
}

/** Normalize a `string | string[]` param to an array (`undefined` → `[]`). */
function toArray(v: string | string[] | undefined): string[] {
	if (v === undefined) return [];
	return Array.isArray(v) ? v : [v];
}

const grepOverrideSchema = Type.Object({
	pattern: Type.Union([Type.String(), Type.Array(Type.String())], {
		description:
			"Search pattern (regex, or literal with literal:true). String or array; an array combines patterns per matchMode (any = OR, all = AND on the same line)",
	}),
	matchMode: Type.Optional(
		Type.Union([Type.Literal("any"), Type.Literal("all")], {
			description:
				'How multiple patterns combine (default "any"). "any": line matches at least one pattern. "all": line must match every pattern — equivalent to `grep A | grep B`',
		}),
	),
	excludePattern: Type.Optional(
		Type.Union([Type.String(), Type.Array(Type.String())], {
			description:
				"Drop lines matching this pattern, like grep -v (string or array; same regex/literal/ignoreCase settings as pattern). Applied after pattern matching",
		}),
	),
	outputMode: Type.Optional(
		Type.Union([Type.Literal("content"), Type.Literal("files"), Type.Literal("count")], {
			description:
				'Output shape (default "content"). "content": anchored matching lines. "files": only file paths with matches (rg -l). "count": per-file match counts + total (grep -c)',
		}),
	),
	wordMatch: Type.Optional(Type.Boolean({ description: "Match whole words only (rg -w)" })),
	path: Type.Union([Type.String(), Type.Array(Type.String())], {
		description: "Directory or file to search (string or array of paths; default: current directory)",
	}),
	glob: Type.Optional(Type.String({ description: "Filter files by glob pattern, e.g. '*.ts' or '**/*.spec.ts'" })),
	ignoreCase: Type.Optional(Type.Boolean({ description: "Case-insensitive search (default: false)" })),
	literal: Type.Optional(
		Type.Boolean({ description: "Treat pattern as literal string instead of regex (default: false)" }),
	),
	context: Type.Optional(
		Type.Number({ description: "Number of lines to show before and after each match (default: 0); context lines are anchored too" }),
	),
	limit: Type.Optional(Type.Number({ description: "Maximum number of matching lines to return (default: 100)" })),
});

interface RgMatch {
	filePath: string;
	lineNumber: number;
}

/**
 * Convert the anchored grep output (grouped, `LINE#HASH│`) into a human-readable
 * form for the TUI: drop the hash, keep file headers and line numbers. Within each
 * file group, the common leading whitespace shared by all matched lines is folded
 * into a single marker (›) so deep, repeated indentation doesn't eat display width;
 * each line's indentation relative to that common base is preserved. The model still
 * receives the anchored `content` text verbatim — this only affects what the user sees.
 */
function countLeading(s: string): number {
	const m = s.match(/^[ \t]*/);
	return m ? m[0].length : 0;
}

function toDisplayLines(raw: string, theme: any): string[] {
	const out: string[] = [];
	const lines = raw.split("\n");
	let i = 0;
	while (i < lines.length) {
		const line = lines[i];
		const h = line.match(/^(.+?) · (\d+ match(?:es)?)$/);
		if (h) {
			out.push(theme.fg("success", h[1]) + theme.fg("dim", ` · ${h[2]}`));
			// collect the anchor lines in this file group
			const group: { lineNo: string; content: string }[] = [];
			let j = i + 1;
			while (j < lines.length) {
				const a = parseHashline(lines[j]);
				if (!a) break;
				group.push({ lineNo: a.lineNo, content: a.content });
				j++;
			}
			// common base = min leading whitespace across the group; fold it into a marker
			const base = group.length ? Math.min(...group.map((g) => countLeading(g.content))) : 0;
			const marker = base > 0 ? theme.fg("dim", "›") + " " : "";
			for (const g of group) {
				const body = g.content.slice(base);
				out.push(theme.fg("dim", `   ${g.lineNo}: `) + marker + theme.fg("toolOutput", body));
			}
			i = j;
			continue;
		}
		if (line.startsWith("[")) out.push(theme.fg("warning", line));
		else out.push(theme.fg("toolOutput", line));
		i++;
	}
	return out;
}

/** Build the grep override (a ToolDefinition fragment for registerTool). */
export function makeGrepOverride(cwd: string) {
	const builtin = createGrepTool(cwd);
	const delegate = (toolCallId: string, params: any, signal: AbortSignal | undefined, onUpdate: any) =>
		builtin.execute(toolCallId, params, signal, onUpdate);

	return {
		name: "grep" as const,
		label: "grep",
		description:
			"Search file contents for a pattern. Results are grouped by file with LINE#HASH anchors usable directly in edit. Supports multi-pattern AND (matchMode:all), line exclusion (excludePattern, grep -v), whole-word matching (wordMatch), multiple search paths, and files-only / count output modes — the common `grep A | grep -v B` / `rg -l` / `grep -c` pipelines without bash. Respects .gitignore.",
		promptSnippet:
			"Search file contents; results show LINE#HASH anchors usable directly in edit; multi-pattern AND, exclude, files-only and count modes replace bash grep pipelines",
		promptGuidelines: [
			"Results are grouped by file under a `path · N matches` header; each line shows `LINE#HASH│content` (same format as read).",
			"Copy `LINE#HASH` straight into an edit `anchor`/`end` — no re-read needed. Context lines (from `context`) are anchored and editable too.",
			"Prefer this over bash pipes: `matchMode:\"all\"` + `excludePattern` express `grep A | grep -v B`; `outputMode:\"files\"`/`\"count\"` replace `rg -l`/`grep -c` when you only need locations or counts. `files` output pastes back as a `path` array.",
			"Pass `pattern` (string or array); optionally `path` (string or array), `glob`, `ignoreCase`, `literal`, `wordMatch`, `context` (lines before+after each match), `limit` (max matches, default 100).",
		],
		parameters: grepOverrideSchema,

		renderShell: "default" as const,

		renderCall(args: any, theme: any) {
			const rawPattern = args?.pattern;
			const patternText = Array.isArray(rawPattern) ? rawPattern.join(" | ") : String(rawPattern ?? "");
			const rawPath = args?.path;
			const pathText = Array.isArray(rawPath) ? rawPath.join(" ") : String(rawPath ?? ".");
			let text =
				theme.fg("toolTitle", theme.bold("grep ")) +
				theme.fg("accent", `/${patternText}/`) +
				theme.fg("toolOutput", ` in ${pathText}`);
			if (args?.matchMode === "all") text += theme.fg("accent", " all");
			if (args?.excludePattern) {
				const ex = Array.isArray(args.excludePattern) ? args.excludePattern.join(",") : args.excludePattern;
				text += theme.fg("toolOutput", ` -v:${ex}`);
			}
			if (args?.wordMatch) text += theme.fg("toolOutput", " -w");
			if (args?.glob) text += theme.fg("toolOutput", ` (${args.glob})`);
			if (args?.outputMode && args.outputMode !== "content")
				text += theme.fg("success", ` → ${args.outputMode}`);
			if (args?.limit !== undefined) text += theme.fg("toolOutput", ` limit ${args.limit}`);
			return new Text(text, 0, 0);
		},

		renderResult(result: any, { isPartial, expanded }: any, theme: any, context: any) {
			if (isPartial) return new Text(theme.fg("warning", "Searching…"), 0, 0);
			if (context?.isError) {
				const t = result.content?.[0]?.type === "text" ? result.content[0].text.split("\n")[0] : "Error";
				return new Text(theme.fg("error", t), 0, 0);
			}
			const out = result.content?.[0]?.type === "text" ? result.content[0].text : "";
			const styled = toDisplayLines(out, theme);
			const maxLines = expanded ? styled.length : 15;
			const shown = styled.slice(0, maxLines);
			const more =
				!expanded && styled.length > maxLines
					? `\n${theme.fg("muted", `… (${styled.length - maxLines} more lines)`)}`
					: "";
			return new Text(shown.join("\n") + more, 0, 0);
		},

		async execute(toolCallId: string, params: any, signal: AbortSignal | undefined, onUpdate: any): Promise<any> {
			const state = getState();
			// aborted → built-in grep (it handles abort itself)
			if (signal?.aborted) return delegate(toolCallId, params, signal, onUpdate);

			// Plain built-in-shaped params (single string pattern/path, no new fields)
			// can delegate safely; anything else must run the local pipeline below.
			const legacyShaped =
				typeof params.pattern === "string" &&
				params.matchMode === undefined &&
				params.excludePattern === undefined &&
				params.outputMode === undefined &&
				params.wordMatch === undefined &&
				!Array.isArray(params.path);

			// disabled + plain params → built-in grep, exactly as before
			if (!state.config.enabled && legacyShaped) return delegate(toolCallId, params, signal, onUpdate);

			const rgPath = await findRg();
			// ripgrep unavailable → built-in (it can auto-download rg), but only for plain params
			if (!rgPath) {
				if (legacyShaped) return delegate(toolCallId, params, signal, onUpdate);
				throw new Error(
					"ripgrep (rg) not found; extended grep params cannot fall back to the built-in grep. Retry with a simple pattern first, or use bash",
				);
			}

			// disabled + extended params still run locally, formatted without anchors
			const anchored = state.config.enabled;

			const patterns = toArray(params.pattern);
			const excludes = toArray(params.excludePattern);
			if (patterns.length === 0) throw new Error("pattern is required (got an empty array)");
			const matchMode: "any" | "all" = params.matchMode ?? "any";
			const outputMode: "content" | "files" | "count" = params.outputMode ?? "content";
			const { glob, ignoreCase, literal, wordMatch, context, limit } = params;
			const ctx = context && context > 0 ? context : 0;
			const searchPaths = (() => {
				const raw = toArray(params.path);
				return (raw.length ? raw : ["."]).map((p) => canonicalPath(cwd, p));
			})();
			const hashLen = state.config.hashLen;

			// Verify search paths upfront; remember dir-ness for relative display.
			const roots: { path: string; isDir: boolean }[] = [];
			for (const sp of searchPaths) {
				try {
					roots.push({ path: sp, isDir: (await stat(sp)).isDirectory() });
				} catch {
					throw new Error(`Path not found: ${sp}`);
				}
			}

			// Client-side line filters — only AND / exclude need them; "any" is native rg (-e OR).
			const excludeMatchers = excludes.map((p) =>
				compileLineMatcher(p, { literal: !!literal, ignoreCase: !!ignoreCase, word: false }),
			);
			const andMatchers =
				matchMode === "all" && patterns.length > 1
					? patterns.map((p) =>
							compileLineMatcher(p, { literal: !!literal, ignoreCase: !!ignoreCase, word: !!wordMatch }),
						)
					: [];
			const linePasses = (line: string): boolean =>
				andMatchers.every((re) => re.test(line)) && !excludeMatchers.some((re) => re.test(line));

			return new Promise((resolvePromise, reject) => {
				if (signal?.aborted) {
					reject(new Error("Operation aborted"));
					return;
				}

				const args = ["--json", "--line-number", "--color=never", "--hidden"];
				if (ignoreCase) args.push("--ignore-case");
				if (literal) args.push("--fixed-strings");
				if (wordMatch) args.push("--word-regexp");
				if (glob) args.push("--glob", glob);
				for (const p of patterns) args.push("-e", p);
				args.push("--", ...searchPaths);

				const effectiveLimit = Math.max(1, limit ?? DEFAULT_LIMIT);
				const child = spawn(rgPath, args, { stdio: ["ignore", "pipe", "pipe"] });
				const rl = createInterface({ input: child.stdout });
				let stderr = "";
				let matchCount = 0;
				let matchLimitReached = false;
				let linesTruncated = false;
				let aborted = false;
				let killedDueToLimit = false;
				const raw: RgMatch[] = [];

				const cleanup = () => {
					rl.close();
					signal?.removeEventListener("abort", onAbort);
				};
				const stopChild = (dueToLimit = false) => {
					if (!child.killed) {
						killedDueToLimit = dueToLimit;
						child.kill();
					}
				};
				const onAbort = () => {
					aborted = true;
					stopChild();
				};
				signal?.addEventListener("abort", onAbort, { once: true });
				child.stderr?.on("data", (chunk: Buffer) => {
					stderr += chunk.toString();
				});

				rl.on("line", (line: string) => {
					if (!line.trim() || matchCount >= effectiveLimit) return;
					let event: any;
					try {
						event = JSON.parse(line);
					} catch {
						return;
					}
					if (event.type !== "match") return;
					const filePath = event.data?.path?.text;
					const lineNumber = event.data?.line_number;
					if (!filePath || typeof lineNumber !== "number") return;
					// AND / exclude filters run on the matched line's text as streamed
					// by rg, so the limit counts final results, not pre-filter candidates.
					const text = typeof event.data?.lines?.text === "string" ? event.data.lines.text : "";
					if (!linePasses(text.replace(/\r?\n$/, ""))) return;
					matchCount++;
					raw.push({ filePath, lineNumber });
					if (matchCount >= effectiveLimit) {
						matchLimitReached = true;
						stopChild(true);
					}
				});

				child.on("error", (error) => {
					cleanup();
					reject(new Error(`Failed to run ripgrep: ${error.message}`));
				});

				child.on("close", async (code) => {
					cleanup();
					if (aborted) {
						reject(new Error("Operation aborted"));
						return;
					}
					if (!killedDueToLimit && code !== 0 && code !== 1) {
						reject(new Error(stderr.trim() || `ripgrep exited with code ${code}`));
						return;
					}
					if (raw.length === 0) {
						resolvePromise({ content: [{ type: "text", text: "No matches found" }], details: undefined });
						return;
					}

					// Group by file, matches sorted by line number (Map keeps rg's discovery order).
					const byFile = new Map<string, number[]>();
					for (const m of raw) {
						const arr = byFile.get(m.filePath) ?? [];
						arr.push(m.lineNumber);
						byFile.set(m.filePath, arr);
					}
					for (const arr of byFile.values()) arr.sort((a, b) => a - b);

					// Read each file once and hash all its lines; hash is computed from the FULL line.
					const fileCache = new Map<string, { lines: string[]; hashes: string[] }>();
					const getFile = async (fp: string) => {
						let entry = fileCache.get(fp);
						if (!entry) {
							let content = "";
							try {
								content = (await readFile(fp)).toString("utf-8");
							} catch {
								content = "";
							}
							const lines = splitLines(content);
							entry = { lines, hashes: hashFileLines(lines, hashLen) };
							fileCache.set(fp, entry);
						}
						return entry;
					};

					const formatPath = (fp: string): string => {
						for (const root of roots) {
							if (!root.isDir) continue;
							const rel = relative(root.path, fp).replace(/\\/g, "/");
							if (rel && !rel.startsWith("..")) return rel;
						}
						return basename(fp);
					};

					const blocks: string[] = [];
					if (outputMode === "content") {
						for (const [fp, matchLines] of byFile) {
							const { lines, hashes } = await getFile(fp);
							const matchSet = new Set(matchLines);
							// Context windows are rebuilt from surviving matches so context
							// lines of a filtered-out match never leak.
							const windowSet = new Set<number>();
							for (const ln of matchLines) {
								for (let n = Math.max(1, ln - ctx); n <= Math.min(lines.length, ln + ctx); n++) windowSet.add(n);
							}
							const header = anchored
								? `${formatPath(fp)} · ${matchLines.length} match${matchLines.length !== 1 ? "es" : ""}\n`
								: "";
							const rows: string[] = [];
							for (const n of [...windowSet].sort((a, b) => a - b)) {
								const content = lines[n - 1] ?? "";
								const hash = hashes[n - 1] ?? "";
								const { text: disp, wasTruncated } = truncateLine(content.replace(/\r/g, ""));
								if (wasTruncated) linesTruncated = true;
								if (anchored) rows.push(`${n}#${hash}│${disp}`);
								else if (matchSet.has(n)) rows.push(`${formatPath(fp)}:${n}: ${disp}`);
								else rows.push(`${formatPath(fp)}-${n}- ${disp}`);
							}
							blocks.push(`${header}${rows.join("\n")}`);
						}
					} else if (outputMode === "files") {
						for (const fp of byFile.keys()) blocks.push(formatPath(fp));
					} else {
						// count
						let total = 0;
						for (const [fp, matchLines] of byFile) {
							blocks.push(`${formatPath(fp)}: ${matchLines.length}`);
							total += matchLines.length;
						}
						blocks.push(`Total: ${total} match${total !== 1 ? "es" : ""} in ${byFile.size} file${byFile.size !== 1 ? "s" : ""}`);
					}

					let output = blocks.join(outputMode === "content" ? "\n\n" : "\n");
					const truncation = truncateHead(output, { maxBytes: DEFAULT_MAX_BYTES });
					output = truncation.content;

					const notices: string[] = [];
					if (matchLimitReached)
						notices.push(
							`${effectiveLimit} matches limit reached. Use limit=${effectiveLimit * 2} for more, or refine pattern`,
						);
					if (truncation.truncated) notices.push(`${formatSize(DEFAULT_MAX_BYTES)} limit reached`);
					if (linesTruncated)
						notices.push(`Some lines truncated to ${GREP_MAX_LINE_LENGTH} chars. Use read to see full lines`);
					if (notices.length) output += `\n\n[${notices.join(". ")}]`;

					resolvePromise({
						content: [{ type: "text" as const, text: output }],
						details: undefined,
					});
				});
			});
		},
	};
}
