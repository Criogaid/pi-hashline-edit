/**
 * Override grep: search results carry `LINE#HASH│` anchors (same format as
 * read), grouped by file. The model can copy `LINE#HASH` straight into an edit
 * anchor — no re-read needed. Context lines (`-C`) are anchored too.
 *
 * We run ripgrep directly (`--json`) rather than wrap the built-in grep, so we
 * control formatting and can compute each line's hash from its FULL content
 * while displaying a truncated copy. (The built-in grep truncates long lines
 * before formatting; hashing that truncated text would not match what edit
 * verifies against the full line — so the hash must be computed from the full
 * content, independently of what is displayed.)
 *
 * Falls back to the built-in grep when: hashline disabled, aborted, or ripgrep
 * cannot be located.
 *
 * @module pi-hashline-edit/pi
 */

import {
	createGrepTool,
	truncateHead,
	truncateLine,
	formatSize,
	DEFAULT_MAX_BYTES,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { access, constants, readFile, stat } from "node:fs/promises";
import { basename, delimiter, join, relative } from "node:path";
import { homedir } from "node:os";
import { hashFileLines } from "../core/hash.ts";
import { splitLines } from "../core/lines.ts";
import { getState } from "./state.ts";
import { canonicalPath } from "./read-tool.ts";

const DEFAULT_LIMIT = 100;
/** Max chars per result line for display (mirrors pi's truncate.ts; not exported there). */
const GREP_MAX_LINE_LENGTH = 500;

/** Locate ripgrep: pi's bundled bin first, then PATH. Returns null if not found. */
async function findRg(): Promise<string | null> {
	const agentDir = process.env.PI_AGENT_DIR ?? join(homedir(), ".pi", "agent");
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

interface RawMatch {
	filePath: string;
	lineNumber: number;
	match: boolean;
}

/**
 * Convert the anchored grep output (grouped, `LINE#HASH│`) into a human-readable
 * form for the TUI: drop the hash, keep file headers and line numbers. The model
 * still receives the anchored `content` text; this only affects what the user sees.
 */
function toDisplayLines(raw: string, theme: any): string[] {
	const out: string[] = [];
	for (const line of raw.split("\n")) {
		// anchored line first: "lineNo#HASH│content" → "   lineNo: content"
		const a = line.match(/^(\d+)#[A-Za-z0-9]+│(.*)$/);
		if (a) {
			out.push(theme.fg("dim", `   ${a[1]}:`) + theme.fg("toolOutput", ` ${a[2]}`));
			continue;
		}
		// file header: "path · N match(es)" → path accent, count dim
		const h = line.match(/^(.+?) · (\d+ match(?:es)?)$/);
		if (h) {
			out.push(theme.fg("success", h[1]) + theme.fg("dim", ` · ${h[2]}`));
			continue;
		}
		// truncation notice block "[...]"
		if (line.startsWith("[")) {
			out.push(theme.fg("warning", line));
			continue;
		}
		out.push(theme.fg("toolOutput", line));
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
			"Search file contents for a pattern. Matches show per-line content hashes (LINE#HASH│content) grouped by file — copy LINE#HASH straight into an edit anchor, no re-read needed. Context lines (context) are anchored too. Respects .gitignore.",
		promptSnippet: "Search file contents; results show LINE#HASH anchors usable directly in edit (no re-read needed)",
		promptGuidelines: [
			"Results are grouped by file under a `path · N matches` header; each line shows `LINE#HASH│content` (same format as read).",
			"Copy `LINE#HASH` straight into an edit `anchor`/`end` — no re-read needed. Context lines (from `context`) are anchored and editable too.",
			"Pass `pattern`; optionally `path`, `glob`, `ignoreCase`, `literal`, `context` (lines before+after each match), `limit` (max matches, default 100).",
		],
		parameters: builtin.parameters,

		renderShell: "default" as const,

		renderCall(args: any, theme: any) {
			const pattern = args?.pattern ?? "";
			const p = args?.path ?? ".";
			let text =
				theme.fg("toolTitle", theme.bold("grep ")) +
				theme.fg("accent", `/${pattern}/`) +
				theme.fg("toolOutput", ` in ${p}`);
			if (args?.glob) text += theme.fg("toolOutput", ` (${args.glob})`);
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
			// disabled or already aborted → built-in grep (it handles abort itself)
			if (!state.config.enabled || signal?.aborted) return delegate(toolCallId, params, signal, onUpdate);

			const rgPath = await findRg();
			// ripgrep unavailable → degrade to the built-in (which can auto-download rg)
			if (!rgPath) return delegate(toolCallId, params, signal, onUpdate);

			const { pattern, path: searchDir, glob, ignoreCase, literal, context, limit } = params;
			const searchPath = canonicalPath(cwd, searchDir || ".");
			const hashLen = state.config.hashLen;

			let isDir = true;
			try {
				isDir = (await stat(searchPath)).isDirectory();
			} catch {
				return {
					isError: true as const,
					content: [{ type: "text" as const, text: `Path not found: ${searchPath}` }],
					details: undefined,
				};
			}

			return new Promise((resolvePromise, reject) => {
				if (signal?.aborted) {
					reject(new Error("Operation aborted"));
					return;
				}

				const args = ["--json", "--line-number", "--color=never", "--hidden"];
				if (ignoreCase) args.push("--ignore-case");
				if (literal) args.push("--fixed-strings");
				if (glob) args.push("--glob", glob);
				const ctx = context && context > 0 ? context : 0;
				if (ctx > 0) args.push("--context", String(ctx));
				args.push("--", String(pattern), searchPath);

				const effectiveLimit = Math.max(1, limit ?? DEFAULT_LIMIT);
				const child = spawn(rgPath, args, { stdio: ["ignore", "pipe", "pipe"] });
				const rl = createInterface({ input: child.stdout });
				let stderr = "";
				let matchCount = 0;
				let matchLimitReached = false;
				let linesTruncated = false;
				let aborted = false;
				let killedDueToLimit = false;
				const raw: RawMatch[] = [];

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
					if (event.type === "match") {
						matchCount++;
						const filePath = event.data?.path?.text;
						const lineNumber = event.data?.line_number;
						if (filePath && typeof lineNumber === "number") raw.push({ filePath, lineNumber, match: true });
						if (matchCount >= effectiveLimit) {
							matchLimitReached = true;
							stopChild(true);
						}
					} else if (event.type === "context") {
						const filePath = event.data?.path?.text;
						const lineNumber = event.data?.line_number;
						if (filePath && typeof lineNumber === "number") raw.push({ filePath, lineNumber, match: false });
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

					// Dedupe by (file, line); a line that is both a match and a context line counts as a match.
					const map = new Map<string, RawMatch>();
					for (const m of raw) {
						const key = `${m.filePath}:${m.lineNumber}`;
						const prev = map.get(key);
						if (!prev || (!prev.match && m.match)) map.set(key, m);
					}

					// Group by file, each group sorted by line number.
					const byFile = new Map<string, RawMatch[]>();
					for (const m of map.values()) {
						const arr = byFile.get(m.filePath) ?? [];
						arr.push(m);
						byFile.set(m.filePath, arr);
					}
					for (const arr of byFile.values()) arr.sort((a, b) => a.lineNumber - b.lineNumber);

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
						if (isDir) {
							const rel = relative(searchPath, fp).replace(/\\/g, "/");
							if (rel && !rel.startsWith("..")) return rel;
						}
						return basename(fp);
					};

					const blocks: string[] = [];
					for (const [fp, matches] of byFile) {
						const { lines, hashes } = await getFile(fp);
						const n = matches.filter((m) => m.match).length;
						const header = `${formatPath(fp)} · ${n} match${n !== 1 ? "es" : ""}`;
						const rows: string[] = [];
						for (const m of matches) {
							const content = lines[m.lineNumber - 1] ?? "";
							const hash = hashes[m.lineNumber - 1] ?? "";
							const { text: disp, wasTruncated } = truncateLine(content.replace(/\r/g, ""));
							if (wasTruncated) linesTruncated = true;
							rows.push(`${m.lineNumber}#${hash}│${disp}`);
						}
						blocks.push(`${header}\n${rows.join("\n")}`);
					}

					let output = blocks.join("\n\n");
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
