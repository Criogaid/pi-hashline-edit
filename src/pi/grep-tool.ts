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
import { readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { hashFileLines } from "../core/hash.ts";
import { splitLines } from "../core/lines.ts";
import { getState } from "./state.ts";
import { canonicalPath } from "./read-tool.ts";
import { parseHashline } from "./render.ts";
import {
  COMMON_RG_ARGS,
  createLinePredicate,
  matcherArgs,
  resolveIgnoreCase,
  rgBytes,
  rgText,
  runRg,
  runRgPaths,
  validatePatterns,
  type LinePredicate,
  type SearchModes,
} from "./rg-line-filter.ts";
import { intersectRanges, normalizeRanges, subtractRanges, unionRanges, submatchesToLineRanges, type LineRange, type RgSubmatch } from "./rg-line-ranges.ts";

const DEFAULT_LIMIT = 100;
/** Max chars per result line for display (mirrors pi's truncate.ts; not exported there). */
const GREP_MAX_LINE_LENGTH = 500;
const GREP_CONTEXT_MAX = 20;
const WILDCARD_ONLY_REGEX = /^(?:\^?\.(?:[*+?][+?]?)?\$?|[*+?])$/;
const MAX_ALL_PATTERNS = 16;
// ponytail: finite batches bound candidate buffers but still spawn per batch; revisit streaming for sustained large scans.
const FILTER_BATCH_SIZE = 4096;
const FILTER_BATCH_BYTES = 1024 * 1024;
const FILE_BATCH_SIZE = 64;
const FILE_BATCH_ARG_BYTES = 16 * 1024;
const MAX_PENDING_RANGES = 262_144;
const LITERAL_FALLBACK_NOTICE = "Invalid regex; searched all patterns as literal text";
const REGEX_SYNTAX = /[.*+?^${}()|[\]\\]/;
const REGEX_PARSE_ERROR = /^(?:rg: )?regex parse error:/m;

async function resolveLiteralMode(
  patterns: readonly string[],
  explicit: boolean | undefined,
  rgPath: string,
  backend: GrepBackend,
  modes: Pick<SearchModes, "engine" | "multiline">,
  signal: AbortSignal | undefined,
): Promise<boolean> {
  if (modes.engine === "pcre2") return false;
  if (explicit === true) return true;
  if (explicit === undefined && !patterns.some((pattern) => REGEX_SYNTAX.test(pattern))) return true;

  const result = await backend.runRg(
    rgPath,
    [
      ...COMMON_RG_ARGS,
      `--engine=${modes.engine}`,
      modes.multiline ? "--multiline" : "--no-multiline",
      "--quiet",
      ...patterns.flatMap((pattern) => ["-e", pattern]),
      "--",
      "-",
    ],
    signal,
    () => true,
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
  noIgnore: Type.Optional(Type.Boolean({
    description: "Search files normally excluded by ignore files, including .gitignore, .ignore, and .rgignore. Explicit glob filters still apply.",
  })),
  follow: Type.Optional(Type.Boolean({
    description: "Follow symbolic links during directory traversal. Return resolved target paths. This does not grant additional filesystem access.",
  })),
  pcre2: Type.Optional(Type.Boolean({
    description: "Use PCRE2 for lookarounds and backreferences. Forces regex matching with no literal fallback; incompatible with literal:true. Default: the standard ripgrep engine.",
  })),
  multiline: Type.Optional(Type.Boolean({
    description: "Allow matches to span physical lines. Results and filters still operate on physical lines. Dot matches line breaks only with an inline (?s) flag.",
  })),
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
  runRgPaths: typeof runRgPaths;
  resolveIgnoreCase: typeof resolveIgnoreCase;
  validatePatterns: typeof validatePatterns;
  createLinePredicate: typeof createLinePredicate;
}

interface SearchScope {
  globs: readonly string[];
  noIgnore: boolean;
  follow: boolean;
  searchPaths: readonly string[];
}

interface FileIdentity {
  dev: number;
  ino: number;
  size: number;
  mtimeMs: number;
}

function scopeArgs(scope: SearchScope): string[] {
  return [
    "--hidden",
    ...(scope.noIgnore ? ["--no-ignore"] : []),
    ...(scope.follow ? ["--follow"] : []),
    ...scope.globs.flatMap((glob) => ["--glob", glob]),
  ];
}

async function fileIdentity(path: string): Promise<FileIdentity> {
  const value = await stat(path);
  if (!value.isFile()) throw new Error(`Search target is not a regular file: ${path}`);
  return { dev: value.dev, ino: value.ino, size: value.size, mtimeMs: value.mtimeMs };
}

function sameIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size && left.mtimeMs === right.mtimeMs;
}

function rangeCount(files: ReadonlyMap<string, readonly LineRange[]>): number {
  let total = 0;
  for (const ranges of files.values()) total += ranges.length;
  return total;
}

function combineRangeMaps(
  left: ReadonlyMap<string, readonly LineRange[]>,
  right: ReadonlyMap<string, readonly LineRange[]>,
  operation: "union" | "intersect" | "subtract",
): Map<string, LineRange[]> {
  const result = new Map<string, LineRange[]>();
  const paths = operation === "union" ? new Set([...left.keys(), ...right.keys()]) : new Set(left.keys());
  for (const path of paths) {
    const a = left.get(path) ?? [];
    const b = right.get(path) ?? [];
    const ranges = operation === "union" ? unionRanges(a, b)
      : operation === "intersect" ? intersectRanges(a, b) : subtractRanges(a, b);
    if (ranges.length) result.set(path, ranges);
  }
  if (rangeCount(result) > MAX_PENDING_RANGES) throw new Error("Search produced too many pending line ranges; refine the query");
  return result;
}

async function scanPatternRanges(
  backend: GrepBackend,
  rgPath: string,
  files: readonly string[],
  pattern: string,
  modes: SearchModes,
  word: boolean,
  signal: AbortSignal | undefined,
  lineCounts: Map<string, number>,
): Promise<Map<string, LineRange[]>> {
  if (files.length === 0) return new Map();
  const args = [
    ...matcherArgs(modes, word),
    "--json",
    "--line-number",
    "--threads=1",
    "-e",
    pattern,
    "--",
    ...files,
  ];
  const result = new Map<string, LineRange[]>();
  const run = await backend.runRg(rgPath, args, signal, async (line) => {
    let event: any;
    try { event = JSON.parse(line); } catch { return true; }
    if (event.type !== "match") return true;
    const data = event.data;
    if (!data?.path || !data?.lines || !Number.isSafeInteger(data.line_number)) {
      throw new Error("Invalid rg match event");
    }
    const filePath = resolve(rgText(data.path));
    if (!files.includes(filePath)) throw new Error("ripgrep returned an unexpected search path");
    let lineCount = lineCounts.get(filePath);
    if (lineCount === undefined) {
      lineCount = splitLines((await readFile(filePath)).toString("utf8")).length;
      lineCounts.set(filePath, lineCount);
    }
    const bytes = rgBytes(data.lines);
    let submatches: RgSubmatch[];
    if (!Array.isArray(data.submatches)) throw new Error("Invalid rg submatch protocol");
    if (data.submatches.length === 0) submatches = [{ start: bytes.length, end: bytes.length }];
    else submatches = data.submatches.map((match: any) => ({ start: match.start, end: match.end }));
    const ranges = submatchesToLineRanges(bytes, data.line_number, submatches, lineCount);
    result.set(filePath, unionRanges(result.get(filePath) ?? [], ranges));
    if (rangeCount(result) > MAX_PENDING_RANGES) throw new Error("Search produced too many pending line ranges; refine the query");
    return true;
  });
  if (!run.stopped && run.code !== 0 && run.code !== 1) {
    throw new Error(run.stderr.trim() || `ripgrep exited with code ${run.code}`);
  }
  return result;
}

interface ComplexSearchOptions {
  backend: GrepBackend;
  rgPath: string;
  scope: SearchScope;
  patterns: readonly string[];
  excludes: readonly string[];
  matchMode: "any" | "all";
  modes: SearchModes;
  word: boolean;
  limit: number;
  signal?: AbortSignal;
}

async function complexSearch(options: ComplexSearchOptions): Promise<{ raw: RgMatch[]; matchLimitReached: boolean; identities: Map<string, FileIdentity> }> {
  const { backend, rgPath, scope, patterns, excludes, matchMode, modes, word, limit, signal } = options;
  const raw: RgMatch[] = [];
  const identities = new Map<string, FileIdentity>();
  const seen = new Set<string>();
  let matchLimitReached = false;
  let batch: string[] = [];
  let batchBytes = 0;

  const processBatch = async (): Promise<boolean> => {
    const files = batch;
    batch = [];
    batchBytes = 0;
    if (files.length === 0) return true;
    for (const file of files) identities.set(file, await fileIdentity(file));
    const lineCounts = new Map<string, number>();

    let included = new Map<string, LineRange[]>();
    for (let index = 0; index < patterns.length; index++) {
      const candidates = matchMode === "all" && index > 0 ? files.filter((file) => included.has(file)) : files;
      const ranges = await scanPatternRanges(backend, rgPath, candidates, patterns[index], modes, word, signal, lineCounts);
      included = index === 0 ? ranges : combineRangeMaps(included, ranges, matchMode === "all" ? "intersect" : "union");
      if (matchMode === "all" && included.size === 0) break;
    }
    if (included.size && excludes.length) {
      let excluded = new Map<string, LineRange[]>();
      const candidates = files.filter((file) => included.has(file));
      for (const pattern of excludes) {
        excluded = combineRangeMaps(
          excluded,
          await scanPatternRanges(backend, rgPath, candidates, pattern, modes, false, signal, lineCounts),
          "union",
        );
      }
      included = combineRangeMaps(included, excluded, "subtract");
    }

    for (const file of files) {
      if (!sameIdentity(identities.get(file)!, await fileIdentity(file))) {
        throw new Error("File changed during search; rerun the query.");
      }
      for (const [start, end] of included.get(file) ?? []) {
        for (let lineNumber = start; lineNumber < end; lineNumber++) {
          raw.push({ filePath: file, lineNumber });
          if (raw.length >= limit) {
            matchLimitReached = true;
            return false;
          }
        }
      }
    }
    return true;
  };

  const listArgs = [
    ...COMMON_RG_ARGS,
    ...scopeArgs(scope),
    "--files",
    "--null",
    "--",
    ...scope.searchPaths,
  ];
  const listed = await backend.runRgPaths(rgPath, listArgs, signal, async (listedPath) => {
    const absolute = resolve(listedPath);
    const filePath = scope.follow ? await realpath(absolute) : absolute;
    if (seen.has(filePath)) return true;
    seen.add(filePath);
    batch.push(filePath);
    batchBytes += Buffer.byteLength(filePath) + 1;
    return batch.length >= FILE_BATCH_SIZE || batchBytes >= FILE_BATCH_ARG_BYTES ? processBatch() : true;
  });
  if (!listed.stopped && listed.code !== 0 && listed.code !== 1) {
    throw new Error(listed.stderr.trim() || `ripgrep exited with code ${listed.code}`);
  }
  if (!matchLimitReached && batch.length) await processBatch();
  return { raw, matchLimitReached, identities };
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
    runRgPaths,
    resolveIgnoreCase,
    validatePatterns,
    createLinePredicate,
    ...overrides,
  };

  return {
    name: "grep" as const,
    label: "grep",
    description:
      "Search file contents with ripgrep and return LINE#HASH anchors for physical lines. Supports standard or PCRE2 regexes, multiline matching, ignore overrides, and linked directories.",
    promptSnippet: "Search file contents with ripgrep",
    promptGuidelines: [
      "Prefer the grep tool for file-content searches.",
      "Use returned grep anchors directly for edits; no re-read needed.",
      "Use files/count when only paths or counts are needed; use matchMode all and excludePattern instead of shell pipelines.",
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
      if (args?.pcre2) text += theme.fg("toolOutput", " pcre2");
      if (args?.multiline) text += theme.fg("toolOutput", " multiline");
      if (args?.noIgnore) text += theme.fg("toolOutput", " no-ignore");
      if (args?.follow) text += theme.fg("toolOutput", " follow");
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
      const engine: SearchModes["engine"] = params.pcre2 ? "pcre2" : "default";
      const multiline = params.multiline === true;
      if (params.pcre2 === true && params.literal === true) {
        throw new Error("pcre2:true cannot be combined with literal:true. Remove pcre2 for literal searches.");
      }
      const allPatterns = [...patterns, ...excludes];
      const literal = await resolveLiteralMode(
        allPatterns, params.literal, rgPath, backend, { engine, multiline }, signal,
      );
      const literalFallback = !params.pcre2 && params.literal === undefined && literal &&
        allPatterns.some((pattern) => REGEX_SYNTAX.test(pattern));
      const { ignoreCase, wordMatch, context, limit } = params;
      const matcherIgnoreCase = await backend.resolveIgnoreCase(
        rgPath, patterns, { engine, multiline, literal }, ignoreCase, signal,
      );
      const modes: SearchModes = { engine, multiline, literal, ignoreCase: matcherIgnoreCase };
      const ctx = clampContext(context);
      const searchPaths = (() => {
        const values = toArray(params.path);
        return (values.length ? values : ["."]).map((path) => canonicalPath(cwd, path));
      })();
      const scope: SearchScope = {
        globs,
        noIgnore: params.noIgnore === true,
        follow: params.follow === true,
        searchPaths,
      };
      const hashLen = state.config.hashLen;

      for (const searchPath of searchPaths) {
        try { await stat(searchPath); }
        catch { throw new Error(`Path not found: ${searchPath}`); }
      }
      if (matchMode === "all" && patterns.length > MAX_ALL_PATTERNS) {
        throw new Error(`matchMode:"all" supports at most ${MAX_ALL_PATTERNS} patterns`);
      }

      const effectiveLimit = Math.max(1, limit ?? DEFAULT_LIMIT);
      const complex = engine === "pcre2" || multiline;
      let raw: RgMatch[];
      let matchLimitReached: boolean;
      let strictIdentities: Map<string, FileIdentity> | undefined;
      let linesTruncated = false;

      if (complex) {
        await backend.validatePatterns(rgPath, patterns, modes, !!wordMatch, signal);
        await backend.validatePatterns(rgPath, excludes, modes, false, signal);
        const result = await complexSearch({
          backend, rgPath, scope, patterns, excludes, matchMode, modes,
          word: !!wordMatch, limit: effectiveLimit, signal,
        });
        raw = result.raw;
        matchLimitReached = result.matchLimitReached;
        strictIdentities = result.identities;
      } else {
        let matchCount = 0;
        matchLimitReached = false;
        raw = [];
        const args = [
          ...matcherArgs(modes, !!wordMatch),
          "--json",
          "--line-number",
          ...scopeArgs(scope),
        ];
        for (const pattern of matchMode === "all" ? patterns.slice(0, 1) : patterns) args.push("-e", pattern);
        args.push("--", ...searchPaths);

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
            raw.push({ filePath: candidates[index].filePath, lineNumber: candidates[index].lineNumber });
            matchCount++;
            if (matchCount >= effectiveLimit) {
              matchLimitReached = true;
              return false;
            }
          }
          return true;
        };
        const resolvedPaths = new Map<string, string>();
        const seenMatches = new Set<string>();
        const run = await backend.runRg(rgPath, args, signal, async (line) => {
          if (matchCount >= effectiveLimit) return false;
          let event: any;
          try { event = JSON.parse(line); } catch { return true; }
          if (event.type !== "match") return true;
          const data = event.data;
          if (!data?.path || !data?.lines || !Number.isSafeInteger(data.line_number)) return true;
          const reportedPath = resolve(rgText(data.path));
          let filePath = reportedPath;
          if (scope.follow) {
            filePath = resolvedPaths.get(reportedPath) ?? await realpath(reportedPath);
            resolvedPaths.set(reportedPath, filePath);
          }
          const matchKey = `${filePath}\0${data.line_number}`;
          if (seenMatches.has(matchKey)) return true;
          seenMatches.add(matchKey);
          const bytes = rgBytes(data.lines);
          batch.push({ filePath, lineNumber: data.line_number, line: bytes });
          batchBytes += bytes.length;
          if (predicates.length === 0 || batch.length >= FILTER_BATCH_SIZE || batchBytes >= FILTER_BATCH_BYTES) {
            return flushBatch();
          }
          return true;
        });
        if (signal?.aborted) throw new Error("Operation aborted");
        if (!run.stopped && run.code !== 0 && run.code !== 1) {
          throw new Error(run.stderr.trim() || `ripgrep exited with code ${run.code}`);
        }
        if (batch.length && matchCount < effectiveLimit) await flushBatch();
      }

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
          let content: string;
          try {
            content = (await readFile(filePath)).toString("utf-8");
          } catch (error) {
            if (strictIdentities) throw error;
            content = "";
          }
          if (strictIdentities) {
            const baseline = strictIdentities.get(filePath);
            if (!baseline || !sameIdentity(baseline, await fileIdentity(filePath))) {
              throw new Error("File changed during search; rerun the query.");
            }
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
