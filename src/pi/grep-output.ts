/**
 * grep's result: payload rows (anchored or plain previews, file headers and their TUI parser),
 * the payload budget, and every report fact grep states, including search failures.
 *
 * @module pi-hashline-edit/pi
 */
import { truncateHead } from "@earendil-works/pi-coding-agent";
import { DiagnosticBuffer } from "./diagnostic-buffer.ts";
import { displayCarriageReturns, plainRow, type AnchorFormatter } from "./anchor-format.ts";
import type { GrepFileMatch, searchFiles } from "./grep-search.ts";
import type { SearchWarning } from "./error-text.ts";
import { MAX_UNNARROWED_SCAN_BYTES } from "./grep-candidates.ts";
import { rereadMatches, type LineCollector } from "./grep-reread.ts";
import { formatByteSize, type OutputBudgets } from "./budgets.ts";
import { HashlineError } from "../core/errors.ts";
import { serializePath } from "./path.ts";
import type { OutcomeVariant, Report, SuccessFacts } from "./report-schema.ts";

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

/** How the search was bounded and which named paths it skipped; stated with success and failure alike. */
type SearchFacts = Pick<Report, "scanLimit" | "missing">;

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

function previewLine(text: string, column = 0, maxUnits: number): { text: string; kept?: number } {
  if (text.length <= maxUnits) return { text };
  const lead = Math.min(GREP_PREVIEW_LEAD, Math.floor(maxUnits / 5));
  let start = Math.max(0, Math.min(column - lead, text.length - maxUnits));
  // Slice at UTF-16 boundaries without splitting an astral character.
  if (start > 0 && /[\uDC00-\uDFFF]/.test(text[start])) start++;
  let end = Math.min(text.length, start + maxUnits);
  if (end < text.length && /[\uDC00-\uDFFF]/.test(text[end])) end--;
  if (end === start) return { text: "…", kept: 0 };
  return {
    text: `[partial, columns ${start + 1}-${end}] ${start ? "…" : ""}${text.slice(start, end)}${end < text.length ? "…" : ""}`,
    kept: end - start,
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
  /** Rows that establish a narrower displayed preview, indexed from the file header. */
  readonly previewMinimums?: readonly { index: number; units: number }[];
}

/**
 * One file's content block: its header, then a row for each line the second read shows. The
 * first row is narrowed to the space remaining after its header.
 */
function contentBlock(
  { filePath, rows, snapshot }: GrepFileMatch,
  { cwd, anchors, budget }: FormatMatchesOptions,
): LineCollector<FormattedBlock> {
  const columns = new Map(rows.map((match) => [match.lineNumber, match.column]));
  const displayPath = serializePath(cwd, filePath);
  const header = formatFileHeader(displayPath, rows.length);
  const lines = [header];
  const firstRowBytes = budget.grepBytes - Buffer.byteLength(header) - 1;
  const previewMinimums: { index: number; units: number }[] = [];
  return {
    onLine(number, text) {
      // Rows make CR visible one unit for one, so preview columns stay source columns.
      const column = columns.get(number);
      const row = (display: string) =>
        snapshot.validUtf8 ? anchors.row(number, text, display) : plainRow(number, display);
      let preview = previewLine(text, column, budget.grepPreviewUnits);
      if (lines.length === 1) {
        // A row is its prefix followed by the CR-visible preview.
        const prefixBytes = Buffer.byteLength(row(""));
        const fits = (candidate: { text: string }) =>
          prefixBytes + Buffer.byteLength(displayCarriageReturns(candidate.text)) <= firstRowBytes;
        if (!fits(preview)) {
          // Prefer a column range. If its label crowds out the match, keep the character alone.
          let low = 1;
          let high = Math.min(budget.grepPreviewUnits, text.length) - 1;
          preview = { text: "…", kept: 0 };
          while (low <= high) {
            const middle = Math.floor((low + high) / 2);
            const candidate = previewLine(text, column, middle);
            if (fits(candidate)) {
              preview = candidate;
              low = middle + 1;
            } else {
              high = middle - 1;
            }
          }
          if (preview.kept === 0 && text.length) {
            let start = Math.min(column ?? 0, text.length - 1);
            if (/[\uDC00-\uDFFF]/.test(text[start])) start--;
            const character = String.fromCodePoint(text.codePointAt(start)!);
            const compact = {
              text: `${start ? "…" : ""}${character}${start + character.length < text.length ? "…" : ""}`,
              kept: character.length,
            };
            if (fits(compact)) preview = compact;
          }
        }
      }
      if (
        preview.kept !== undefined &&
        preview.kept < (previewMinimums.at(-1)?.units ?? Infinity)
      ) {
        previewMinimums.push({ index: lines.length, units: preview.kept });
      }
      lines.push(row(preview.text));
    },
    finish: () => ({
      lines,
      invalidUtf8: snapshot.validUtf8 ? undefined : displayPath,
      previewMinimums,
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
  readonly context: number;
  readonly matchLimitReached: boolean;
  readonly effectiveLimit: number;
  readonly searchFacts: SearchFacts;
  readonly budget: OutputBudgets;
}

/** Join the payload within the call's byte budget and state each limit, omission, and diagnostic once. */
function assembleGrepOutput(options: AssembleGrepOutputOptions): {
  payload: string;
  facts: SuccessFacts<"grep">;
  next?: OutcomeVariant;
} {
  const {
    formatted,
    cwd,
    warnings,
    outputMode,
    context,
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
  let previewLimit: number | undefined;
  let remainingLines = truncation.outputLines;
  for (const block of blocks) {
    if (remainingLines <= 0) break;
    if (block.invalidUtf8 && remainingLines > 1) invalidUtf8.push(block.invalidUtf8);
    for (const { index, units } of block.previewMinimums ?? []) {
      if (index >= remainingLines) break;
      previewLimit = Math.min(previewLimit ?? Infinity, units);
    }
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
      linePreviewLimit: previewLimit,
      invalidUtf8: invalidUtf8.length ? invalidUtf8 : undefined,
      diagnostics: warnings.length ? searchDiagnostics(warnings, cwd, budget) : undefined,
    },
    // Only content mode with a nonzero context spends the byte budget on context rows.
    next: outputMode === "content" && context > 0 ? "contextRows" : undefined,
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
    /** Resolved paths that do not exist; the other paths were searched. */
    readonly missing: readonly string[];
    readonly effectiveLimit: number;
    /** A literal pattern contains `|`, which matches only that character. */
    readonly literalPipe: boolean;
  },
): Promise<{ payload?: string; facts: SuccessFacts<"grep">; next?: OutcomeVariant }> {
  const {
    cwd,
    search,
    warnings,
    missing,
    outputMode,
    context,
    effectiveLimit,
    literalPipe,
    budget,
  } = options;
  const searchFacts: SearchFacts = {
    scanLimit: search.scanLimitReached ? formatByteSize(MAX_UNNARROWED_SCAN_BYTES) : undefined,
    missing: missing.length ? [...missing] : undefined,
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
    context,
    matchLimitReached: search.matchLimitReached,
    effectiveLimit,
    searchFacts,
    budget,
  });
}
