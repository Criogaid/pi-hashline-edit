/**
 * Override grep: search results carry `LINE#HASH│` anchors (same format as
 * read), grouped by file. The model can copy `LINE#HASH` straight into an edit
 * anchor — no re-read needed. Context lines (`context`) are anchored too.
 *
 * Multiple patterns use OR; outputMode returns anchored content, paths, or counts.
 *
 * We run ripgrep directly (`--json`) rather than wrap the built-in grep, so we
 * control formatting and can compute each line's hash from its FULL content
 * while displaying a truncated copy. (The built-in grep truncates long lines
 * before formatting; hashing that truncated text would not match what edit
 * verifies against the full line — so the hash must be computed from the full
 * content, independently of what is displayed.)
 *
 * The main rg process searches logical physical lines with smart-case.
 * `limit` counts matched lines, while context windows are added only for display.
 * @module pi-hashline-edit/pi
 */

import {
  truncateHead,
  formatSize,
  DEFAULT_MAX_BYTES,
  type ToolDefinition,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import { rgPath as bundledRgPath } from "@vscode/ripgrep";
import { Type, type Static } from "typebox";
import { Text } from "@earendil-works/pi-tui";
import { createHash } from "node:crypto";
import { stat } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { normalizeLineEndings } from "../core/lines.ts";
import { scanTextFile, scanTextLines } from "./text-stream.ts";
import { createAnchorFormatter, displayCarriageReturns } from "./anchor-format.ts";
import { canonicalPath } from "./path.ts";
import { parseHashline, renderToolError } from "./render.ts";
import {
  COMMON_RG_ARGS,
  type RgRunResult,
  matcherArgs,
  resolveIgnoreCase,
  rgBytes,
  rgText,
  runRg,
  runRgPaths,
  type SearchModes,
} from "./rg-line-filter.ts";
import { runRgTextView } from "./rg-text-view.ts";
import { submatchesToLineRanges } from "./rg-line-ranges.ts";

const DEFAULT_LIMIT = 100;
/** Maximum UTF-16 units in a line preview, excluding its partial-line label. */
const GREP_MAX_LINE_LENGTH = 500;
const GREP_CONTEXT_MAX = 20;
const MAX_CONCURRENT_FILE_READS = 16;
const LITERAL_FALLBACK_NOTICE = "Invalid regex; searched the pattern as literal text";
const REGEX_SYNTAX = /[.*+?^${}()|[\]\\]/;
const REGEX_PARSE_ERROR = /^(?:rg: )?regex parse error:/m;

/** Surface incomplete search diagnostics without discarding confirmed matches. */
function recordSearchDiagnostics(result: RgRunResult, warnings?: string[]): void {
  const message =
    result.stderr.trim() ||
    (!result.stopped && result.code !== 0 && result.code !== 1
      ? `ripgrep exited with code ${result.code}`
      : "");
  if (!message) return;
  if (!warnings) throw new Error(message);
  warnings.push(message);
}

function formatSearchWarnings(warnings: readonly string[]): string {
  if (!warnings.length) return "";
  const summary = truncateHead([...new Set(warnings)].join("\n"), { maxBytes: 4 * 1024 });
  return `\n\n[Search incomplete; results and counts cover only confirmed matches.\n${summary.content}${summary.truncated ? "\nAdditional search diagnostics omitted (4 KiB limit)." : ""}]`;
}

function previewLine(text: string, column = 0): { text: string; wasTruncated: boolean } {
  if (text.length <= GREP_MAX_LINE_LENGTH) return { text, wasTruncated: false };
  let start = Math.max(0, Math.min(column - 100, text.length - GREP_MAX_LINE_LENGTH));
  // Slice at UTF-16 boundaries without splitting an astral character.
  if (start > 0 && /[\uDC00-\uDFFF]/.test(text[start])) start++;
  let end = Math.min(text.length, start + GREP_MAX_LINE_LENGTH);
  if (end < text.length && /[\uDC00-\uDFFF]/.test(text[end])) end--;
  return {
    text: `[partial, columns ${start + 1}-${end}] ${start ? "…" : ""}${text.slice(start, end)}${end < text.length ? "…" : ""}`,
    wasTruncated: true,
  };
}

async function resolveLiteralMode(
  patterns: readonly string[],
  explicit: boolean | undefined,
  multiline: boolean,
  rgPath: string,
  backend: GrepBackend,
  signal: AbortSignal | undefined,
  allowFallback: boolean,
): Promise<boolean> {
  if (explicit === true) return true;
  if (explicit === undefined && !patterns.some((pattern) => REGEX_SYNTAX.test(pattern)))
    return true;

  const result = await backend.runRg(
    rgPath,
    [
      ...COMMON_RG_ARGS,
      "--engine=default",
      multiline ? "--multiline" : "--no-multiline",
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
    if (!allowFallback)
      throw new Error(
        `Invalid regex in compound query; automatic literal fallback is disabled. Fix the regex or set literal:true for all patterns.\n${result.stderr.trim()}`,
      );
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

const grepOverrideSchema = Type.Object(
  {
    pattern: Type.Union([Type.String(), Type.Array(Type.String())], {
      description:
        "Non-empty string or array of non-empty strings (OR across patterns; whitespace-only strings are valid). For code snippets with regex punctuation, set literal:true; use an array for alternatives instead of joining literals with |.",
    }),
    path: Type.Optional(
      Type.Union([Type.String(), Type.Array(Type.String())], {
        description:
          "Search an existing file or directory (string or array; default: current directory). Path wildcards are not expanded; use glob to filter filenames.",
      }),
    ),
    glob: Type.Optional(
      Type.Union([Type.String(), Type.Array(Type.String())], {
        description:
          "Filter filenames with a wildcard glob pattern; pass an array for multiple filters and prefix exclusions with `!`, e.g. ['*.ts', '!**/*.test.ts']",
      }),
    ),
    literal: Type.Optional(
      Type.Boolean({
        description:
          "Set true for literal code text, especially calls, brackets, pipes, and backslashes. Set false only for intentional ripgrep Rust regex. Automatic mode tries regex for metacharacters; one invalid pattern can fall back to searching the entire input literally, but invalid pattern arrays fail. Literal mode uses the same case setting as regex mode.",
      }),
    ),
    ignoreCase: Type.Optional(
      Type.Boolean({
        description:
          "Override query-level smart-case: true ignores case; false distinguishes case. Inline regex case flags can still override either setting. Omit for smart-case across the whole query.",
      }),
    ),
    multiline: Type.Optional(
      Type.Boolean({
        description:
          "Allow matches across physical lines (default: false). CRLF is searched as LF; results anchor each distinct physical line touched by a match. Context only changes displayed lines.",
      }),
    ),
    context: Type.Optional(
      Type.Integer({
        minimum: 0,
        maximum: GREP_CONTEXT_MAX,
        description: `Number of lines to show before and after each match (0-${GREP_CONTEXT_MAX}; default: 0). Set to 3-5 when searching code to edit so surrounding lines and anchors are included without needing a separate read; context lines are anchored too`,
      }),
    ),
    // Pi converts Type.Integer arguments with Math.trunc before schema validation.
    limit: Type.Optional(
      Type.Number({
        minimum: 1,
        multipleOf: 1,
        description: "Positive integer maximum of matching lines to return (default: 100)",
      }),
    ),
    outputMode: Type.Optional(
      Type.Union([Type.Literal("content"), Type.Literal("files"), Type.Literal("count")], {
        description:
          '"content" (default): anchored lines. "files": paths. "count": matching lines per file and total. All modes share the limit on matching lines.',
      }),
    ),
  },
  { additionalProperties: false },
);
type GrepTool = ToolDefinition<typeof grepOverrideSchema, { incomplete?: true } | undefined>;

interface RgMatch {
  filePath: string;
  lineNumber: number;
  column?: number;
  matchedText?: string;
}

interface RgJsonEvent {
  type: string;
  data?: {
    path?: Parameters<typeof rgText>[0];
    lines?: Parameters<typeof rgBytes>[0];
    line_number?: number;
    submatches?: { start: number; end: number }[];
  };
}

/** @internal — injectable process boundary for deterministic tests. */
export interface GrepBackend {
  runRg: typeof runRg;
  runRgPaths: typeof runRgPaths;
  resolveIgnoreCase: typeof resolveIgnoreCase;
}

interface SearchScope {
  globs: readonly string[];
  noIgnore: boolean;
  follow: boolean;
  searchPaths: readonly string[];
}

function scopeArgs(scope: SearchScope): string[] {
  return [
    "--hidden",
    ...(scope.noIgnore ? ["--no-ignore"] : []),
    ...(scope.follow ? ["--follow"] : []),
    ...scope.globs.flatMap((glob) => ["--glob", glob]),
  ];
}

interface SearchPathInfo {
  path: string;
  isFile: boolean;
}

function fileKey(path: string): string {
  const absolute = resolve(path);
  return process.platform === "win32" ? absolute.toLowerCase() : absolute;
}

async function filterExplicitFilesByGlob(
  backend: GrepBackend,
  rgPath: string,
  scope: SearchScope,
  paths: readonly SearchPathInfo[],
  signal: AbortSignal | undefined,
  warnings: string[],
): Promise<string[]> {
  const explicitFiles = paths.filter(({ isFile }) => isFile);
  if (scope.globs.length === 0 || explicitFiles.length === 0) return paths.map(({ path }) => path);

  const parents = [...new Set(explicitFiles.map(({ path }) => dirname(path)))];
  const allowed = new Set<string>();
  // Direct file arguments bypass ignore and symlink traversal; let only the ordered globs decide admission.
  const args = [
    ...COMMON_RG_ARGS,
    ...scopeArgs({ ...scope, noIgnore: true, follow: true }),
    "--files",
    "--null",
    "--max-depth=1",
    "--",
    ...parents,
  ];
  const listed = await backend.runRgPaths(rgPath, args, signal, async (path) => {
    allowed.add(fileKey(path));
    return true;
  });
  recordSearchDiagnostics(listed, warnings);
  return paths
    .filter(({ path, isFile }) => !isFile || allowed.has(fileKey(path)))
    .map(({ path }) => path);
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

function toDisplayLines(raw: string, theme: Theme): string[] {
  const out: string[] = [];
  const lines = raw.split("\n");
  const lineNoWidth = lines.reduce(
    (width, line) => Math.max(width, parseHashline(line)?.lineNo.length ?? 0),
    0,
  );
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
        out.push(
          theme.fg("dim", `   ${g.lineNo.padStart(lineNoWidth)}: `) +
            marker +
            theme.fg("toolOutput", body),
        );
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
interface SearchMatchesOptions {
  backend: GrepBackend;
  rgPath: string;
  scope: SearchScope;
  patterns: readonly string[];
  modes: SearchModes;
  limit: number;
  outputMode: "content" | "files" | "count";
  signal?: AbortSignal;
  warnings: string[];
}

async function scanFileRevision(filePath: string, signal?: AbortSignal) {
  const hash = createHash("sha256");
  const stats = await scanTextFile(filePath, undefined, signal, (bytes) => hash.update(bytes));
  return { ...stats, revision: hash.digest("hex") };
}

function fileReadWarning(
  filePath: string,
  error: unknown,
  signal?: AbortSignal,
): string | undefined {
  if (signal?.aborted || !(error instanceof Error) || !("code" in error)) return undefined;
  return `Could not read ${filePath}: ${error.message}`;
}

async function searchMatches(options: SearchMatchesOptions) {
  const { backend, rgPath, scope, patterns, modes, limit, outputMode, signal, warnings } = options;
  const raw: RgMatch[] = [];
  const revisions = new Map<string, string>();
  const lineCounts = new Map<string, number>();
  let matchLimitReached = false;
  const unreadableFiles = new Set<string>();
  const seenMatches = new Set<string>();
  // rg reports non-overlapping spans, so overlapping multiline OR patterns need separate scans.
  const patternGroups = modes.multiline ? patterns.map((pattern) => [pattern]) : [patterns];
  for (const group of patternGroups) {
    const args = [
      ...matcherArgs(modes),
      "--json",
      "--line-number",
      ...scopeArgs(scope),
      ...group.flatMap((pattern) => ["-e", pattern]),
      "--",
      ...scope.searchPaths,
    ];
    const run = await backend.runRg(rgPath, args, signal, async (line) => {
      if (raw.length >= limit) return false;
      let event: RgJsonEvent;
      try {
        event = JSON.parse(line);
      } catch {
        return true;
      }
      if (event.type !== "match") return true;
      const data = event.data;
      if (
        !data?.path ||
        !data.lines ||
        typeof data.line_number !== "number" ||
        !Number.isSafeInteger(data.line_number)
      )
        return true;
      const filePath = resolve(rgText(data.path));
      const startLine = data.line_number;
      const bytes = rgBytes(data.lines);
      const addMatch = async (match: RgMatch) => {
        if (unreadableFiles.has(filePath)) return true;
        const matchKey = `${filePath}\0${match.lineNumber}`;
        if (seenMatches.has(matchKey)) return true;
        seenMatches.add(matchKey);
        if (outputMode === "content" && !revisions.has(filePath)) {
          try {
            const stats = await scanFileRevision(filePath, signal);
            if (stats.hasNul) throw new Error("UNSUPPORTED_TEXT: NUL bytes are not editable.");
            revisions.set(filePath, stats.revision);
          } catch (error) {
            const warning = fileReadWarning(filePath, error, signal);
            if (!warning) throw error;
            warnings.push(warning);
            unreadableFiles.add(filePath);
            return true;
          }
        }
        raw.push(match);
        if (raw.length >= limit) {
          matchLimitReached = true;
          return false;
        }
        return true;
      };
      if (!modes.multiline) {
        return addMatch({
          filePath,
          lineNumber: startLine,
          column: bytes.subarray(0, data.submatches?.[0]?.start ?? 0).toString("utf8").length,
          matchedText: bytes.toString("utf8").replace(/\n$/, ""),
        });
      }
      if (unreadableFiles.has(filePath)) return true;
      if (!Array.isArray(data.submatches)) throw new Error("Invalid rg multiline match event");
      let lineCount = lineCounts.get(filePath);
      if (lineCount === undefined) {
        try {
          const stats =
            outputMode === "content"
              ? await scanFileRevision(filePath, signal)
              : await scanTextFile(filePath, undefined, signal);
          if (stats.hasNul) throw new Error("UNSUPPORTED_TEXT: NUL bytes are not editable.");
          lineCount = stats.totalLines;
          lineCounts.set(filePath, lineCount);
          if ("revision" in stats && typeof stats.revision === "string") {
            revisions.set(filePath, stats.revision);
          }
        } catch (error) {
          const warning = fileReadWarning(filePath, error, signal);
          if (!warning) throw error;
          warnings.push(warning);
          unreadableFiles.add(filePath);
          return true;
        }
      }
      const columns = new Map<number, number>();
      const submatches = data.submatches.length ? data.submatches : [{ start: 0, end: 0 }];
      const ranges = submatchesToLineRanges(bytes, startLine, submatches, lineCount, columns);
      const texts = bytes.toString("utf8").replace(/\n$/, "").split("\n");
      for (const [start, end] of ranges) {
        for (let lineNumber = start; lineNumber < end; lineNumber++) {
          if (
            !(await addMatch({
              filePath,
              lineNumber,
              column: columns.get(lineNumber),
              matchedText: texts[lineNumber - startLine],
            }))
          )
            return false;
        }
      }
      return true;
    });
    if (signal?.aborted) throw new Error("Operation aborted");
    recordSearchDiagnostics(run, warnings);
    if (matchLimitReached) break;
  }
  return { raw, matchLimitReached, revisions };
}

interface FormatMatchesOptions {
  cwd: string;
  raw: readonly RgMatch[];
  outputMode: "content" | "files" | "count";
  context: number;
  anchors: ReturnType<typeof createAnchorFormatter>;
  signal?: AbortSignal;
  warnings: string[];
  searchRevisions: ReadonlyMap<string, string>;
}

async function formatMatches(options: FormatMatchesOptions) {
  const { cwd, raw, outputMode, context, anchors, signal, warnings, searchRevisions } = options;
  const byFile = new Map<string, RgMatch[]>();
  for (const match of raw) {
    const lines = byFile.get(match.filePath) ?? [];
    lines.push(match);
    byFile.set(match.filePath, lines);
  }
  for (const lines of byFile.values()) lines.sort((a, b) => a.lineNumber - b.lineNumber);
  const formatPath = (filePath: string): string => {
    const absolute = resolve(cwd, filePath);
    const rel = relative(cwd, absolute);
    return rel && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)
      ? rel.replace(/\\/g, "/")
      : absolute;
  };
  const blocks: string[] = [];
  let linesTruncated = false;
  if (outputMode === "content") {
    const fileEntries = [...byFile.entries()];
    const fileResults = new Array<{ block?: string; warning?: string }>(fileEntries.length);
    let nextIndex = 0;
    const workerAbort = new AbortController();
    const scanSignal = signal ? AbortSignal.any([signal, workerAbort.signal]) : workerAbort.signal;
    let failed = false;
    let failure: unknown;
    const workers = Array.from(
      { length: Math.min(MAX_CONCURRENT_FILE_READS, fileEntries.length) },
      async () => {
        try {
          while (!workerAbort.signal.aborted && nextIndex < fileEntries.length) {
            const current = nextIndex++;
            const [filePath, matchLines] = fileEntries[current];
            const columns = new Map(matchLines.map((match) => [match.lineNumber, match.column]));
            const matchedTexts = new Map(
              matchLines.map((match) => [match.lineNumber, match.matchedText]),
            );
            const windowSet = new Set<number>();
            for (const { lineNumber } of matchLines) {
              for (let n = Math.max(1, lineNumber - context); n <= lineNumber + context; n++)
                windowSet.add(n);
            }
            const rows: string[] = [];
            const matchedRows = new Set<number>();
            const hash = createHash("sha256");
            try {
              const stats = await scanTextLines(
                filePath,
                (number) => windowSet.has(number),
                (line) => {
                  if (line.text === undefined) return;
                  const matchedText = matchedTexts.get(line.number);
                  if (matchedText !== undefined && matchedText !== line.text) {
                    throw new Error("File changed during search; rerun the query.");
                  }
                  if (matchedTexts.has(line.number)) matchedRows.add(line.number);
                  const { text: display, wasTruncated } = previewLine(
                    displayCarriageReturns(line.text),
                    columns.get(line.number),
                  );
                  if (wasTruncated) linesTruncated = true;
                  rows.push(anchors.row(line.number, line.text, display));
                },
                { signal: scanSignal, onBytes: (bytes) => hash.update(bytes) },
              );
              if (stats.hasNul) throw new Error("UNSUPPORTED_TEXT: NUL bytes are not editable.");
              if (matchLines.some(({ lineNumber }) => !matchedRows.has(lineNumber))) {
                throw new Error("File changed during search; rerun the query.");
              }
              const searchRevision = searchRevisions.get(filePath);
              if (searchRevision && searchRevision !== hash.digest("hex")) {
                throw new Error("File changed during search; rerun the query.");
              }
              const header = `${formatPath(filePath)} · ${matchLines.length} match${matchLines.length !== 1 ? "es" : ""}\n`;
              fileResults[current] = { block: header + rows.join("\n") };
            } catch (error) {
              const warning = fileReadWarning(filePath, error, scanSignal);
              if (!warning) throw error;
              fileResults[current] = { warning };
            }
          }
        } catch (error) {
          if (!failed) {
            failed = true;
            failure = error;
            workerAbort.abort();
          }
        }
      },
    );
    await Promise.all(workers);
    if (failed) throw failure;
    for (const result of fileResults) {
      if (result.warning) warnings.push(result.warning);
      else if (result.block) blocks.push(result.block);
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
  return { blocks, linesTruncated };
}

interface AssembleGrepOutputOptions {
  blocks: readonly string[];
  warnings: readonly string[];
  outputMode: "content" | "files" | "count";
  literalFallback: boolean;
  matchLimitReached: boolean;
  effectiveLimit: number;
  linesTruncated: boolean;
}

function assembleGrepOutput(options: AssembleGrepOutputOptions): {
  content: [{ type: "text"; text: string }];
  details: { incomplete: true } | undefined;
} {
  const {
    blocks,
    warnings,
    outputMode,
    literalFallback,
    matchLimitReached,
    effectiveLimit,
    linesTruncated,
  } = options;

  if (!blocks.length && warnings.length) {
    throw new Error(`No matches could be displayed.${formatSearchWarnings(warnings)}`);
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
      `Line previews capped at ${GREP_MAX_LINE_LENGTH} chars (anchors hash full lines); use read for full content`,
    );
  }
  if (notices.length) output += `\n\n[${notices.join(". ")}]`;
  output += formatSearchWarnings(warnings);

  return {
    content: [{ type: "text" as const, text: output }],
    details: warnings.length ? { incomplete: true } : undefined,
  };
}

/** Build the production grep override (a ToolDefinition fragment for registerTool). */
export function makeGrepOverride(cwd: string) {
  return makeGrepOverrideWithBackend(cwd, {});
}

/** @internal — build a grep override with deterministic process backends for tests. */
export function makeGrepOverrideWithBackend(cwd: string, overrides: Partial<GrepBackend>) {
  const backend: GrepBackend = {
    runRg: runRgTextView,
    runRgPaths,
    resolveIgnoreCase,
    ...overrides,
  };

  return {
    name: "grep" as const,
    label: "grep",
    description:
      "Search LF-normalized file contents with ripgrep. Content mode returns LINE#HASH anchors for logical lines; files/count modes return paths or limited matching-line counts. CRLF queries normalize to LF; standalone CR stays content. Pattern arrays use OR; smart-case applies unless ignoreCase overrides it. Set multiline:true to match across lines; context only changes display. Directory searches respect ignore rules and skip linked directories.",
    promptSnippet: "Search file contents with ripgrep",
    promptGuidelines: [
      "Prefer grep for file-content searches.",
      "Use existing files or directories in path; put filename wildcards in glob.",
      "Use literal:true for code containing regex punctuation; use literal:false only for intentional regex.",
      "Use a pattern array for OR alternatives.",
      "Copy grep anchors directly into edit; inspect the full line before rewriting from a partial preview.",
      "Use context:3-5 when searching code to edit so surrounding lines are anchored.",
      "Use files/count when only paths or counts are needed.",
      "Use multiline:true for cross-line matches.",
      "Use another tool to traverse ignored or linked directories.",
    ],
    parameters: grepOverrideSchema,

    renderShell: "default" as const,

    renderCall(
      args: Static<typeof grepOverrideSchema>,
      theme: Parameters<NonNullable<GrepTool["renderCall"]>>[1],
    ) {
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
      if (args?.glob) text += theme.fg("toolOutput", ` (${toArray(args.glob).join(", ")})`);
      if (args?.outputMode && args.outputMode !== "content")
        text += theme.fg("success", ` → ${args.outputMode}`);
      if (args?.limit !== undefined) text += theme.fg("toolOutput", ` limit ${args.limit}`);
      return new Text(text, 0, 0);
    },

    renderResult(
      result: Parameters<NonNullable<GrepTool["renderResult"]>>[0],
      { isPartial, expanded }: Parameters<NonNullable<GrepTool["renderResult"]>>[1],
      theme: Parameters<NonNullable<GrepTool["renderResult"]>>[2],
      context: Parameters<NonNullable<GrepTool["renderResult"]>>[3],
    ) {
      if (isPartial) return new Text(theme.fg("warning", "Searching…"), 0, 0);
      if (context?.isError) return renderToolError(result, theme);
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
      params: Static<typeof grepOverrideSchema>,
      signal: AbortSignal | undefined,
      _onUpdate: Parameters<GrepTool["execute"]>[3],
    ) {
      if (signal?.aborted) throw new Error("Operation aborted");
      const unsupported = Object.keys(params).filter(
        (key) => !Object.hasOwn(grepOverrideSchema.properties, key),
      );
      if (unsupported.length)
        throw new Error(
          `grep parameters not supported: ${unsupported.join(", ")}. Allowed: ${Object.keys(grepOverrideSchema.properties).join(", ")}`,
        );
      const anchors = createAnchorFormatter();
      const warnings: string[] = [];

      const patterns = toArray(params.pattern).map(normalizeLineEndings);
      if (patterns.length === 0) throw new Error("pattern is required (got an empty array)");
      if (patterns.some((pattern) => pattern.length === 0)) {
        throw new Error("pattern must not be empty");
      }

      const effectiveLimit = params.limit ?? DEFAULT_LIMIT;
      if (!Number.isSafeInteger(effectiveLimit) || effectiveLimit < 1) {
        throw new Error("limit must be a positive integer");
      }
      const rgPath = bundledRgPath;
      const outputMode: "content" | "files" | "count" = params.outputMode ?? "content";
      const multiline = params.multiline ?? false;
      const globs = toArray(params.glob);
      const literal = await resolveLiteralMode(
        patterns,
        params.literal,
        multiline,
        rgPath,
        backend,
        signal,
        patterns.length === 1,
      );
      const literalFallback =
        params.literal === undefined &&
        literal &&
        patterns.some((pattern) => REGEX_SYNTAX.test(pattern));
      const matcherIgnoreCase = await backend.resolveIgnoreCase(
        rgPath,
        patterns,
        { literal, multiline },
        params.ignoreCase,
        signal,
      );
      const modes: SearchModes = { literal, ignoreCase: matcherIgnoreCase, multiline };
      const ctx = clampContext(params.context);
      const searchPaths = (() => {
        const values = toArray(params.path);
        return (values.length ? values : ["."]).map((path) => canonicalPath(cwd, path));
      })();
      let scope: SearchScope = {
        globs,
        noIgnore: false,
        follow: false,
        searchPaths,
      };

      const pathInfo: SearchPathInfo[] = [];
      for (const searchPath of searchPaths) {
        try {
          pathInfo.push({ path: searchPath, isFile: (await stat(searchPath)).isFile() });
        } catch (error) {
          const missing =
            typeof error === "object" &&
            error !== null &&
            "code" in error &&
            error.code === "ENOENT";
          const hint =
            missing && /[*?]/.test(searchPath)
              ? " Use an existing directory as path and a filename wildcard as glob."
              : "";
          throw new Error(`Path not found: ${searchPath}${hint}`);
        }
      }
      scope = {
        ...scope,
        searchPaths: await filterExplicitFilesByGlob(
          backend,
          rgPath,
          scope,
          pathInfo,
          signal,
          warnings,
        ),
      };

      const result =
        scope.searchPaths.length === 0
          ? { raw: [], matchLimitReached: false, revisions: new Map<string, string>() }
          : await searchMatches({
              backend,
              rgPath,
              scope,
              patterns,
              modes,
              limit: effectiveLimit,
              outputMode,
              signal,
              warnings,
            });
      const { raw, matchLimitReached } = result;

      if (raw.length === 0) {
        if (warnings.length)
          throw new Error(`No matches confirmed.${formatSearchWarnings(warnings)}`);
        return {
          content: [
            {
              type: "text" as const,
              text:
                "No matches found" + (literalFallback ? `\n\n[${LITERAL_FALLBACK_NOTICE}]` : ""),
            },
          ],
          details: undefined,
        };
      }

      const { blocks, linesTruncated } = await formatMatches({
        cwd,
        raw,
        outputMode,
        context: ctx,
        anchors,
        signal,
        warnings,
        searchRevisions: result.revisions,
      });
      return assembleGrepOutput({
        blocks,
        warnings,
        outputMode,
        literalFallback,
        matchLimitReached,
        effectiveLimit,
        linesTruncated,
      });
    },
  } satisfies GrepTool;
}
