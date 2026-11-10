/**
 * grep's result: payload rows (anchored or plain previews, file headers and their TUI parser),
 * the payload budget, and every report fact grep states, including search failures.
 *
 * @module pi-hashline-edit/pi
 */
import { truncateHead } from "@earendil-works/pi-coding-agent";
import { DiagnosticBuffer } from "./diagnostic-buffer.ts";
import { plainRow, type AnchorFormatter } from "./anchor-format.ts";
import type { GrepFileMatch, searchFiles } from "./grep-search.ts";
import type { SearchWarning } from "./error-text.ts";
import { MAX_UNNARROWED_SCAN_BYTES } from "./grep-candidates.ts";
import { rereadMatches, type LineCollector } from "./grep-reread.ts";
import { formatByteSize, type OutputBudgets } from "./budgets.ts";
import { HashlineError } from "../core/errors.ts";
import { serializePath } from "./path.ts";
import type { Report, SuccessFacts } from "./report-schema.ts";

/** How grep presents matches; the tool's schema offers these and this module formats each. */
export const GREP_OUTPUT_MODES = ["content", "files", "count"] as const;
export type GrepOutputMode = (typeof GREP_OUTPUT_MODES)[number];

/** UTF-16 units kept before the match column when a preview window is cut. */
const GREP_PREVIEW_LEAD = 100;

/** Content-mode file header: `<path> · <N> match(es)`. parseFileHeader is its TUI parser. */
function formatFileHeader(path: string, matches: number): string {
  return `${path} · ${matches} match${matches !== 1 ? "es" : ""}`;
}
const FILE_HEADER = /^(.+?) · (\d+ match(?:es)?)$/s;

export function parseFileHeader(line: string): { path: string; summary: string } | undefined {
  const match = FILE_HEADER.exec(line);
  return match ? { path: match[1], summary: match[2] } : undefined;
}

/** Distinct search diagnostics within their budget, keeping opening context and the final cause. */
function searchDiagnostics(
  warnings: readonly SearchWarning[],
  cwd: string,
  budget: OutputBudgets,
): string {
  const diagnostics = new DiagnosticBuffer(budget.fieldBytes);
  const seen = new Set<string>();
  for (const warning of warnings) {
    const key = `${warning.path ?? ""}\u0000${warning.reason}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const path = warning.path ? `${serializePath(cwd, warning.path)}: ` : "";
    diagnostics.append(`${path}${warning.reason}\n`);
  }
  return diagnostics.toString().trimEnd();
}

/** How the search was bounded; stated with success and failure alike. */
type SearchFacts = Pick<Report, "scanLimit">;

/** No result can be returned from an incomplete search: report it rather than "no matches". */
function searchIncompleteError(
  message: string,
  warnings: readonly SearchWarning[],
  cwd: string,
  budget: OutputBudgets,
  searchFacts: SearchFacts,
): HashlineError<"SEARCH_INCOMPLETE"> {
  return new HashlineError("SEARCH_INCOMPLETE", message, {
    facts: { ...searchFacts, diagnostics: searchDiagnostics(warnings, cwd, budget) },
  });
}

function previewLine(
  text: string,
  column = 0,
  maxUnits: number,
): { text: string; wasTruncated: boolean } {
  if (text.length <= maxUnits) return { text, wasTruncated: false };
  const lead = Math.min(GREP_PREVIEW_LEAD, Math.floor(maxUnits / 5));
  let start = Math.max(0, Math.min(column - lead, text.length - maxUnits));
  // Slice at UTF-16 boundaries without splitting an astral character.
  if (start > 0 && /[\uDC00-\uDFFF]/.test(text[start])) start++;
  let end = Math.min(text.length, start + maxUnits);
  if (end < text.length && /[\uDC00-\uDFFF]/.test(text[end])) end--;
  return {
    text: `[partial, columns ${start + 1}-${end}] ${start ? "…" : ""}${text.slice(start, end)}${end < text.length ? "…" : ""}`,
    wasTruncated: true,
  };
}

interface FormatMatchesOptions {
  readonly cwd: string;
  readonly files: readonly GrepFileMatch[];
  readonly outputMode: GrepOutputMode;
  readonly context: number;
  readonly anchors: AnchorFormatter;
  readonly signal?: AbortSignal;
  readonly budget: OutputBudgets;
}

interface FormattedBlock {
  readonly lines: readonly string[];
  readonly invalidUtf8?: string;
  /** Zero-based index within this block, including its file header. */
  readonly firstTruncatedLine?: number;
}

/** One file's content block: its header, then a row for each line the second read shows. */
function contentBlock(
  { filePath, rows, snapshot }: GrepFileMatch,
  { cwd, anchors, budget }: FormatMatchesOptions,
): LineCollector<FormattedBlock> {
  const columns = new Map(rows.map((match) => [match.lineNumber, match.column]));
  const displayPath = serializePath(cwd, filePath);
  const lines = [formatFileHeader(displayPath, rows.length)];
  let firstTruncatedLine: number | undefined;
  return {
    onLine(number, text) {
      // Rows make CR visible one unit for one, so preview columns stay source columns.
      const { text: display, wasTruncated } = previewLine(
        text,
        columns.get(number),
        budget.grepPreviewUnits,
      );
      if (wasTruncated) firstTruncatedLine ??= lines.length;
      lines.push(
        snapshot.validUtf8 ? anchors.row(number, text, display) : plainRow(number, display),
      );
    },
    finish: () => ({
      lines,
      invalidUtf8: snapshot.validUtf8 ? undefined : displayPath,
      firstTruncatedLine,
    }),
  };
}

async function formatMatches(options: FormatMatchesOptions) {
  const { cwd, files, outputMode, context, signal } = options;
  const formatPath = (filePath: string): string => serializePath(cwd, filePath);
  const blocks: FormattedBlock[] = [];
  /** Files left out after their second read, in result order. */
  const warnings: SearchWarning[] = [];
  // Paths and counts state the searched snapshot as is; content rows come from a second read.
  let fileCount = files.length;
  let matches = files.reduce((sum, file) => sum + file.rows.length, 0);
  if (outputMode === "content") {
    const results = await rereadMatches(files, context, signal, (file) =>
      contentBlock(file, options),
    );
    for (const [index, result] of results.entries()) {
      if ("warning" in result) {
        warnings.push(result.warning);
        fileCount--;
        matches -= files[index].rows.length;
      } else {
        blocks.push(result.value);
      }
    }
  }
  if (outputMode === "files") {
    for (const { filePath } of files) blocks.push({ lines: [formatPath(filePath)] });
  } else if (outputMode === "count") {
    for (const { filePath, rows } of files)
      blocks.push({ lines: [`${formatPath(filePath)}: ${rows.length}`] });
  }
  return { blocks, matches, files: fileCount, warnings };
}

interface AssembleGrepOutputOptions {
  readonly formatted: Omit<Awaited<ReturnType<typeof formatMatches>>, "warnings">;
  readonly cwd: string;
  readonly warnings: readonly SearchWarning[];
  readonly outputMode: GrepOutputMode;
  readonly matchLimitReached: boolean;
  readonly effectiveLimit: number;
  readonly searchFacts: SearchFacts;
  readonly budget: OutputBudgets;
}

/** Join the payload within the call's byte budget and state each limit, omission, and diagnostic once. */
function assembleGrepOutput(options: AssembleGrepOutputOptions): {
  payload: string;
  facts: SuccessFacts<"grep">;
} {
  const {
    formatted,
    cwd,
    warnings,
    outputMode,
    matchLimitReached,
    effectiveLimit,
    searchFacts,
    budget,
  } = options;
  const { blocks, matches, files } = formatted;

  if (!blocks.length && warnings.length) {
    throw searchIncompleteError(
      "No matches could be displayed.",
      warnings,
      cwd,
      budget,
      searchFacts,
    );
  }
  const truncation = truncateHead(
    blocks.map((block) => block.lines.join("\n")).join(outputMode === "content" ? "\n\n" : "\n"),
    { maxBytes: budget.grepBytes, maxLines: Number.MAX_SAFE_INTEGER },
  );
  const invalidUtf8: string[] = [];
  let linesTruncated = false;
  let remainingLines = truncation.outputLines;
  for (const block of blocks) {
    if (remainingLines <= 0) break;
    if (block.invalidUtf8 && remainingLines > 1) invalidUtf8.push(block.invalidUtf8);
    if (block.firstTruncatedLine !== undefined && remainingLines > block.firstTruncatedLine)
      linesTruncated = true;
    remainingLines -= block.lines.length + (outputMode === "content" ? 1 : 0);
  }
  // One complete content or count block already states its path and match count.
  const countsShown = outputMode !== "files" && blocks.length === 1 && !truncation.truncated;
  return {
    payload: truncation.content,
    facts: {
      ...(countsShown ? {} : { matches, files }),
      ...searchFacts,
      matchLimit: matchLimitReached ? effectiveLimit : undefined,
      outputLimit: truncation.truncated ? formatByteSize(budget.grepBytes) : undefined,
      linePreviewLimit: linesTruncated ? budget.grepPreviewUnits : undefined,
      invalidUtf8: invalidUtf8.length ? invalidUtf8 : undefined,
      diagnostics: warnings.length ? searchDiagnostics(warnings, cwd, budget) : undefined,
    },
  };
}

/**
 * grep's payload and report facts for a finished search. The payload is absent when nothing
 * matched; a search that cannot confirm any result fails with SEARCH_INCOMPLETE instead.
 */
export async function grepOutput(
  options: Omit<FormatMatchesOptions, "files"> & {
    readonly search: Omit<Awaited<ReturnType<typeof searchFiles>>, "warnings">;
    /** Scope and search warnings, in the order those stages produced them. */
    readonly warnings: readonly SearchWarning[];
    readonly effectiveLimit: number;
    /** A literal pattern contains `|`, which matches only that character. */
    readonly literalPipe: boolean;
  },
): Promise<{ payload?: string; facts: SuccessFacts<"grep"> }> {
  const { cwd, search, warnings, outputMode, effectiveLimit, literalPipe, budget } = options;
  const searchFacts: SearchFacts = {
    scanLimit: search.scanLimitReached ? formatByteSize(MAX_UNNARROWED_SCAN_BYTES) : undefined,
  };
  if (search.files.length === 0) {
    if (warnings.length)
      throw searchIncompleteError("No matches confirmed.", warnings, cwd, budget, searchFacts);
    return {
      // A literal `|` finding nothing most likely meant alternatives.
      facts: { matches: 0, files: 0, ...searchFacts, literalPipe: literalPipe || undefined },
    };
  }
  const { warnings: rereadWarnings, ...formatted } = await formatMatches({
    ...options,
    files: search.files,
  });
  return assembleGrepOutput({
    formatted,
    cwd,
    warnings: [...warnings, ...rereadWarnings],
    outputMode,
    matchLimitReached: search.matchLimitReached,
    effectiveLimit,
    searchFacts,
    budget,
  });
}
