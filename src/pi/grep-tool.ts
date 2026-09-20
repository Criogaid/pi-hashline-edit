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
 * The main rg process uses native OR, or the first required pattern for AND.
 * Batched rg predicates evaluate AND / exclude against candidate lines with the
 * same resolved literal and case modes, so Rust regex semantics remain authoritative
 * throughout. Each batch closes stdin and waits for rg to exit. `limit` counts final
 * results, and context windows are rebuilt only around surviving matches.
 * @module pi-hashline-edit/pi
 */

import {
  truncateHead,
  truncateLine,
  formatSize,
  DEFAULT_MAX_BYTES,
} from "@earendil-works/pi-coding-agent";
import { rgPath as bundledRgPath } from "@vscode/ripgrep";
import { Type } from "typebox";
import { Text } from "@earendil-works/pi-tui";
import { readFile, stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { hashFileLines } from "../core/hash.ts";
import { splitLines } from "../core/lines.ts";
import { getState } from "./state.ts";
import { canonicalPath } from "./read-tool.ts";
import { parseHashline } from "./render.ts";
import {
  BASE_RG_ARGS,
  createLinePredicate,
  resolveIgnoreCase,
  rgBytes,
  runRg,
  type LinePredicate,
  type SearchModes,
} from "./rg-line-filter.ts";

const DEFAULT_LIMIT = 100;
/** Max chars per result line for display (mirrors pi's truncate.ts; not exported there). */
const GREP_MAX_LINE_LENGTH = 500;
const GREP_CONTEXT_MAX = 20;
const WILDCARD_ONLY_REGEX = /^(?:\^?\.(?:[*+?][+?]?)?\$?|[*+?])$/;
const MAX_ALL_PATTERNS = 16;
// ponytail: finite batches bound candidate buffers but still spawn per batch; revisit streaming for sustained large scans.
const FILTER_BATCH_SIZE = 4096;
const FILTER_BATCH_BYTES = 1024 * 1024;


const REGEX_SYNTAX = /[.*+?^${}()|[\]\\]/;
const REGEX_PARSE_ERROR = /^(?:rg: )?regex parse error:/m;
const LITERAL_FALLBACK_NOTICE = "Invalid regex; searched all patterns as literal text";

async function resolveLiteralMode(
  patterns: readonly string[],
  explicit: boolean | undefined,
  rgPath: string,
  backend: GrepBackend,
  signal: AbortSignal | undefined,
): Promise<boolean> {
  if (explicit === true) return true;
  if (explicit === undefined && !patterns.some((pattern) => REGEX_SYNTAX.test(pattern))) return true;

  // Validate every regex, including filters that may receive no candidate lines.
  const result = await backend.runRg(
    rgPath, [...BASE_RG_ARGS, "--quiet", ...patterns.flatMap((pattern) => ["-e", pattern]), "--", "-"],
    signal, () => true,
  );
  if (signal?.aborted) throw new Error("Operation aborted");
  if (result.code === 0 || result.code === 1) return false;
  if (result.code === 2 && REGEX_PARSE_ERROR.test(result.stderr)) {
    if (explicit === false) throw new Error(result.stderr.trim());
    return true;
  }
  throw new Error(result.stderr.trim() || `ripgrep exited with code ${result.code}`);
}

/** Normalize a `string | string[]` param to an array (`undefined` → `[]`). */
function toArray(v: string | string[] | undefined): string[] {
  if (v === undefined) return [];
  return Array.isArray(v) ? v : [v];
}

function clampContext(context: number | undefined): number {
  if (!context || !Number.isFinite(context) || context < 0) return 0;
  return Math.min(Math.floor(context), GREP_CONTEXT_MAX);
}

const grepOverrideSchema = Type.Object({
  pattern: Type.Union([Type.String(), Type.Array(Type.String())], {
    description:
      "Non-empty pattern(s). Arrays use matchMode. Wildcard-only searches require literal:true.",
  }),
  matchMode: Type.Optional(
    Type.Union([Type.Literal("any"), Type.Literal("all")], {
      description:
        `"any" (default): OR. "all": AND on the same line (maximum ${MAX_ALL_PATTERNS} patterns).`,
    }),
  ),
  excludePattern: Type.Optional(
    Type.Union([Type.String(), Type.Array(Type.String())], {
      description:
        "Drop lines matching any exclusion after pattern matching.",
    }),
  ),
  outputMode: Type.Optional(
    Type.Union([Type.Literal("content"), Type.Literal("files"), Type.Literal("count")], {
      description:
        '"content" (default): anchored lines. "files": paths. "count": matching lines per file and total.',
    }),
  ),
  wordMatch: Type.Optional(Type.Boolean({ description: "Whole words in pattern only (rg -w)" })),
  path: Type.Optional(Type.Union([Type.String(), Type.Array(Type.String())], {
    description:
      "Directory or file to search (string or array of paths; default: current directory)",
  })),
  glob: Type.Optional(
    Type.Union([Type.String(), Type.Array(Type.String())], {
      description: "Filter files by glob pattern; pass an array for multiple filters and prefix exclusions with `!`, e.g. ['*.ts', '!**/*.test.ts']",
    }),
  ),
  ignoreCase: Type.Optional(
    Type.Boolean({ description: "true: ignore case; false: match case. Default: ripgrep smart-case across inclusion patterns. The resolved default also applies to exclusions." }),
  ),
  literal: Type.Optional(
    Type.Boolean({
      description: "true: literal; false: regex, no fallback. Shared by pattern/excludePattern. Default: literal unless any pattern has regex syntax; any rg parse failure makes all literal.",
    }),
  ),
  context: Type.Optional(
    Type.Integer({
      minimum: 0,
      maximum: GREP_CONTEXT_MAX,
      description: `Number of lines to show before and after each match (0-${GREP_CONTEXT_MAX}; default: 0); context lines are anchored too`,
    }),
  ),
  limit: Type.Optional(
    Type.Number({ description: "Maximum number of matching lines to return (default: 100)" }),
  ),
});

interface RgMatch {
  filePath: string;
  lineNumber: number;
}

/** @internal — injectable process boundary for deterministic tests. */
export interface GrepBackend {
  runRg: typeof runRg;
  resolveIgnoreCase: typeof resolveIgnoreCase;
  createLinePredicate: typeof createLinePredicate;
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

/** Build the production grep override (a ToolDefinition fragment for registerTool). */
export function makeGrepOverride(cwd: string) {
  return makeGrepOverrideWithBackend(cwd, {});
}

/** @internal — build a grep override with deterministic process backends for tests. */
export function makeGrepOverrideWithBackend(cwd: string, overrides: Partial<GrepBackend>) {
  const backend: GrepBackend = {
    runRg,
    resolveIgnoreCase,
    createLinePredicate,
    ...overrides,
  };

  return {
    name: "grep" as const,
    label: "grep",
    description:
      "Search file contents; respects .gitignore. Groups matches by file with LINE#HASH anchors, including context.",
    promptSnippet: "Search file contents",
    promptGuidelines: [
      "Prefer the grep tool for file-content searches.",
      "Use returned grep anchors directly for edits; no re-read needed.",
      "Prefer files/count for paths/counts; use all/exclude instead of shell pipelines.",
    ],
    parameters: grepOverrideSchema,

    renderShell: "default" as const,

    renderCall(args: any, theme: any) {
      const rawPattern = args?.pattern;
      const patternText = Array.isArray(rawPattern)
        ? rawPattern.join(" | ")
        : String(rawPattern ?? "");
      const rawPath = args?.path;
      const pathText = Array.isArray(rawPath) ? rawPath.join(" ") : String(rawPath ?? ".");
      let text =
        theme.fg("toolTitle", theme.bold("grep ")) +
        theme.fg("accent", `/${patternText}/`) +
        theme.fg("toolOutput", ` in ${pathText}`);
      if (args?.matchMode === "all") text += theme.fg("accent", " all");
      if (args?.excludePattern) {
        const ex = Array.isArray(args.excludePattern)
          ? args.excludePattern.join(",")
          : args.excludePattern;
        text += theme.fg("toolOutput", ` -v:${ex}`);
      }
      if (args?.wordMatch) text += theme.fg("toolOutput", " -w");
      if (args?.glob) text += theme.fg("toolOutput", ` (${toArray(args.glob).join(", ")})`);
      if (args?.outputMode && args.outputMode !== "content")
        text += theme.fg("success", ` → ${args.outputMode}`);
      if (args?.limit !== undefined) text += theme.fg("toolOutput", ` limit ${args.limit}`);
      return new Text(text, 0, 0);
    },

    renderResult(result: any, { isPartial, expanded }: any, theme: any, context: any) {
      if (isPartial) return new Text(theme.fg("warning", "Searching…"), 0, 0);
      if (context?.isError) {
        const t =
          result.content?.[0]?.type === "text" ? result.content[0].text.split("\n")[0] : "Error";
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

    async execute(
      _toolCallId: string,
      params: any,
      signal: AbortSignal | undefined,
      _onUpdate: any,
    ): Promise<any> {
      const state = getState();
      if (signal?.aborted) throw new Error("Operation aborted");

      const patterns = toArray(params.pattern);
      if (patterns.length === 0) throw new Error("pattern is required (got an empty array)");
      if (patterns.some((pattern) => pattern.trim() === "")) {
        throw new Error("pattern must not be empty");
      }
      if (params.literal !== true) {
        const wildcard = patterns.find((pattern) => WILDCARD_ONLY_REGEX.test(pattern.trim()));
        if (wildcard !== undefined) {
          throw new Error(
            `Pattern ${JSON.stringify(wildcard)} is wildcard-only; use read for a known file or provide a concrete substring or identifier`,
          );
        }
      }

      const rgPath = bundledRgPath;
      const excludes = toArray(params.excludePattern);
      const matchMode: "any" | "all" = params.matchMode ?? "any";
      const outputMode: "content" | "files" | "count" = params.outputMode ?? "content";
      const globs = toArray(params.glob);
      const allPatterns = [...patterns, ...excludes];
      const literal = await resolveLiteralMode(allPatterns, params.literal, rgPath, backend, signal);
      const literalFallback = params.literal === undefined && literal &&
        allPatterns.some((pattern) => REGEX_SYNTAX.test(pattern));
      const { ignoreCase, wordMatch, context, limit } = params;
      const matcherIgnoreCase = await backend.resolveIgnoreCase(
        rgPath, patterns, literal, ignoreCase, signal,
      );
      const modes: SearchModes = { literal, ignoreCase: matcherIgnoreCase };
      const ctx = clampContext(context);
      const searchPaths = (() => {
        const raw = toArray(params.path);
        return (raw.length ? raw : ["."]).map((p) => canonicalPath(cwd, p));
      })();
      const hashLen = state.config.hashLen;

      // Verify search paths upfront so a typo fails fast with a clear error
      // (rg's own diagnostics are less actionable).
      for (const sp of searchPaths) {
        try {
          await stat(sp);
        } catch {
          throw new Error(`Path not found: ${sp}`);
        }
      }

      if (matchMode === "all" && patterns.length > MAX_ALL_PATTERNS) {
        throw new Error(`matchMode:"all" supports at most ${MAX_ALL_PATTERNS} patterns`);
      }

      const args = [
        ...BASE_RG_ARGS,
        "--json",
        "--line-number",
        "--hidden",
        matcherIgnoreCase ? "--ignore-case" : "--case-sensitive",
      ];
      if (literal) args.push("--fixed-strings");
      if (wordMatch) args.push("--word-regexp");
      for (const glob of globs) args.push("--glob", glob);
      // The first AND condition already gates candidates; only the remaining conditions need filtering.
      for (const pattern of matchMode === "all" ? patterns.slice(0, 1) : patterns) args.push("-e", pattern);
      args.push("--", ...searchPaths);

      const effectiveLimit = Math.max(1, limit ?? DEFAULT_LIMIT);
      let matchCount = 0;
      let matchLimitReached = false;
      let linesTruncated = false;
      const raw: RgMatch[] = [];

      const andPredicates = matchMode === "all"
        ? patterns.slice(1).map((pattern) => backend.createLinePredicate(rgPath, [pattern], modes, !!wordMatch, signal))
        : [];
      const exclusionPredicate = excludes.length
        ? backend.createLinePredicate(rgPath, excludes, modes, false, signal)
        : undefined;
      const predicates: LinePredicate[] = [...andPredicates, ...(exclusionPredicate ? [exclusionPredicate] : [])];

      const batch: { filePath: string; lineNumber: number; line: Buffer }[] = [];
      let batchBytes = 0;
      const flushBatch = async (): Promise<boolean> => {
        const candidates = batch.splice(0);
        batchBytes = 0;
        const lines = candidates.map(({ line }) => line);
        const decisions = await Promise.all(predicates.map((predicate) => predicate(lines)));
        for (let index = 0; index < candidates.length; index++) {
          if (!decisions.every((results, predicate) =>
            predicate < andPredicates.length ? results[index] : !results[index],
          )) continue;

          const { filePath, lineNumber } = candidates[index];
          matchCount++;
          raw.push({ filePath, lineNumber });
          if (matchCount >= effectiveLimit) {
            matchLimitReached = true;
            return false;
          }
        }
        return true;
      };

      const { code, stderr, stopped } = await backend.runRg(
        rgPath,
        args,
        signal,
        async (line) => {
          if (matchCount >= effectiveLimit) return false;
          let event: any;
          try {
            event = JSON.parse(line);
          } catch {
            return true;
          }
          if (event.type !== "match") return true;
          const filePath = event.data?.path?.text;
          const lineNumber = event.data?.line_number;
          const eventLines = event.data?.lines;
          if (!filePath || typeof lineNumber !== "number" || !eventLines) return true;

          const bytes = rgBytes(eventLines);
          batch.push({ filePath, lineNumber, line: bytes });
          batchBytes += bytes.length;
          if (predicates.length === 0 || batch.length >= FILTER_BATCH_SIZE || batchBytes >= FILTER_BATCH_BYTES) {
            return flushBatch();
          }
          return true;
        },
      );
      if (signal?.aborted) throw new Error("Operation aborted");
      if (!stopped && code !== 0 && code !== 1) {
        throw new Error(stderr.trim() || `ripgrep exited with code ${code}`);
      }
      if (batch.length && matchCount < effectiveLimit) await flushBatch();

      if (raw.length === 0) {
        return {
          content: [{ type: "text" as const, text: literalFallback
            ? `No matches found\n\n[${LITERAL_FALLBACK_NOTICE}]` : "No matches found" }],
          details: undefined,
        };
      }

      // Group by file, matches sorted by line number (Map keeps rg's discovery order).
      const byFile = new Map<string, number[]>();
      for (const match of raw) {
        const lines = byFile.get(match.filePath) ?? [];
        lines.push(match.lineNumber);
        byFile.set(match.filePath, lines);
      }
      for (const lines of byFile.values()) lines.sort((a, b) => a - b);

      // Read each file once and hash all its lines; hash is computed from the FULL line.
      const fileCache = new Map<string, { lines: string[]; hashes: string[] }>();
      const getFile = async (filePath: string) => {
        let entry = fileCache.get(filePath);
        if (!entry) {
          let content = "";
          try {
            content = (await readFile(filePath)).toString("utf-8");
          } catch {
            content = "";
          }
          const lines = splitLines(content);
          entry = { lines, hashes: hashFileLines(lines, hashLen) };
          fileCache.set(filePath, entry);
        }
        return entry;
      };

      const formatPath = (filePath: string): string => {
        const absolute = resolve(cwd, filePath);
        const rel = relative(cwd, absolute);
        return rel && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)
          ? rel.replace(/\\/g, "/")
          : absolute;
      };

      const blocks: string[] = [];
      if (outputMode === "content") {
        for (const [filePath, matchLines] of byFile) {
          const { lines, hashes } = await getFile(filePath);
          // Context windows are rebuilt from surviving matches so context
          // lines of a filtered-out match never leak.
          const windowSet = new Set<number>();
          for (const lineNumber of matchLines) {
            for (
              let n = Math.max(1, lineNumber - ctx);
              n <= Math.min(lines.length, lineNumber + ctx);
              n++
            ) windowSet.add(n);
          }
          const header = `${formatPath(filePath)} · ${matchLines.length} match${matchLines.length !== 1 ? "es" : ""}\n`;
          const rows: string[] = [];
          for (const n of [...windowSet].sort((a, b) => a - b)) {
            const content = lines[n - 1] ?? "";
            const hash = hashes[n - 1] ?? "";
            const { text: display, wasTruncated } = truncateLine(content.replace(/\r/g, ""));
            if (wasTruncated) linesTruncated = true;
            rows.push(`${n}#${hash}│${display}`);
          }
          blocks.push(`${header}${rows.join("\n")}`);
        }
      } else if (outputMode === "files") {
        for (const filePath of byFile.keys()) blocks.push(formatPath(filePath));
      } else {
        let total = 0;
        for (const [filePath, matchLines] of byFile) {
          blocks.push(`${formatPath(filePath)}: ${matchLines.length}`);
          total += matchLines.length;
        }
        blocks.push(
          `Total: ${total} match${total !== 1 ? "es" : ""} in ${byFile.size} file${byFile.size !== 1 ? "s" : ""}`,
        );
      }

      let output = blocks.join(outputMode === "content" ? "\n\n" : "\n");
      const truncation = truncateHead(output, { maxBytes: DEFAULT_MAX_BYTES });
      output = truncation.content;

      const notices: string[] = literalFallback ? [LITERAL_FALLBACK_NOTICE] : [];
      if (matchLimitReached) {
        notices.push(
          `${effectiveLimit} matches limit reached. Use limit=${effectiveLimit * 2} for more, or refine pattern`,
        );
      }
      if (truncation.truncated) notices.push(`${formatSize(DEFAULT_MAX_BYTES)} limit reached`);
      if (linesTruncated) {
        notices.push(
          `Some lines truncated to ${GREP_MAX_LINE_LENGTH} chars. Use read to see full lines`,
        );
      }
      if (notices.length) output += `\n\n[${notices.join(". ")}]`;

      return {
        content: [{ type: "text" as const, text: output }],
        details: undefined,
      };
    },
  };
}
