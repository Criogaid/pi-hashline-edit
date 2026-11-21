/**
 * grep's result: payload rows (anchored or plain previews, file headers and their TUI parser),
 * the payload budget, and every report fact grep states, including search failures.
 *
 * @module pi-hashline-edit/pi
 */
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

/**
 * The row between two groups of rows that are not adjacent lines of one file, as ripgrep prints
 * it. Only a search with context rows has groups; grep-render reads this row back for the TUI.
 */
export const CONTEXT_GAP = "--";

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

/** A row's displayed text; `kept` counts the UTF-16 units shown when the line was cut. */
interface Preview {
  readonly text: string;
  readonly kept?: number;
}

/** Slices start and end on this so an astral character is never split. */
const LOW_SURROGATE = /[\uDC00-\uDFFF]/;

function previewLine(text: string, column = 0, maxUnits: number): Preview {
  if (text.length <= maxUnits) return { text };
  const lead = Math.min(GREP_PREVIEW_LEAD, Math.floor(maxUnits / 5));
  let start = Math.max(0, Math.min(column - lead, text.length - maxUnits));
  if (start > 0 && LOW_SURROGATE.test(text[start])) start--;
  let end = Math.min(text.length, start + maxUnits);
  if (end < text.length && LOW_SURROGATE.test(text[end])) end--;
  if (end === start) return { text: "…", kept: 0 };
  return {
    text: `[partial, columns ${start + 1}-${end}] ${start ? "…" : ""}${text.slice(start, end)}${end < text.length ? "…" : ""}`,
    kept: end - start,
  };
}

/**
 * The widest preview narrower than `maxUnits` that `fits`: a column range, or, when the range
 * label crowds out the match, the matched character alone.
 */
function narrowPreview(
  text: string,
  column: number | undefined,
  maxUnits: number,
  fits: (preview: Preview) => boolean,
): Preview {
  let preview: Preview = { text: "…", kept: 0 };
  let low = 1;
  let high = Math.min(maxUnits, text.length) - 1;
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
  if (preview.kept !== 0 || !text.length) return preview;
  let start = Math.min(column ?? 0, text.length - 1);
  if (LOW_SURROGATE.test(text[start])) start--;
  const character = String.fromCodePoint(text.codePointAt(start)!);
  const compact = {
    text: `${start ? "…" : ""}${character}${start + character.length < text.length ? "…" : ""}`,
    kept: character.length,
  };
  return fits(compact) ? compact : preview;
}

interface FormatMatchesOptions {
  readonly cwd: string;
  readonly files: readonly GrepFileMatch[];
  readonly outputMode: GrepOutputMode;
  readonly context: number;
  readonly anchors: AnchorFormatter;
  readonly signal: AbortSignal;
  readonly budget: OutputBudgets;
}

interface PreviewMinimum {
  readonly index: number;
  readonly units: number;
}

/** One file's content rows; row indices count from its header at 0. */
interface ContentBlock {
  readonly lines: readonly string[];
  readonly displayPath: string;
  /** False when the file is not valid UTF-8, so its rows are plain previews. */
  readonly validUtf8: boolean;
  /** Rows that establish a narrower displayed preview. */
  readonly previewMinimums: readonly PreviewMinimum[];
  /** In a search with context rows, each hit's row and the row it shows once context is removed. */
  readonly hits: readonly { readonly index: number; readonly soloRow: string }[];
  /** In a search with context rows, the rows that open a group after a gap in line numbers. */
  readonly gapIndices: readonly number[];
}

/** Formatted results in result order: content blocks, or one row per file in files and count modes. */
type FormattedBlocks =
  | {
      readonly mode: "content";
      readonly blocks: readonly ContentBlock[];
      readonly contextRows: boolean;
    }
  | { readonly mode: Exclude<GrepOutputMode, "content">; readonly rows: readonly string[] };

/**
 * One file's content block: its header, then a row for each line the second read shows. The
 * first row is narrowed to the space remaining after its header.
 */
function contentBlock(
  { filePath, rows, snapshot }: GrepFileMatch,
  { cwd, anchors, budget, context }: FormatMatchesOptions,
): LineCollector<ContentBlock> {
  const columns = new Map(rows.map((match) => [match.lineNumber, match.column]));
  const displayPath = serializePath(cwd, filePath);
  const header = formatFileHeader(displayPath, rows.length);
  const lines = [header];
  const firstRowBytes = budget.grepBytes - Buffer.byteLength(header) - 1;
  const previewMinimums: PreviewMinimum[] = [];
  const hits: { index: number; soloRow: string }[] = [];
  const gapIndices: number[] = [];
  let previousLine = 0;
  return {
    onLine(number, text) {
      // Rows make CR visible one unit for one, so preview columns stay source columns.
      const column = columns.get(number);
      if (context > 0 && lines.length > 1 && number > previousLine + 1)
        gapIndices.push(lines.length);
      previousLine = number;
      const row = (display: string) =>
        snapshot.validUtf8 ? anchors.row(number, text, display) : plainRow(number, display);
      /** This line's preview narrowed to fit as row one: its prefix, then the CR-visible text. */
      const fitRowOne = (candidate: Preview): Preview => {
        const prefixBytes = Buffer.byteLength(row(""));
        const fits = (preview: Preview) =>
          prefixBytes + Buffer.byteLength(displayCarriageReturns(preview.text)) <= firstRowBytes;
        return fits(candidate)
          ? candidate
          : narrowPreview(text, column, budget.grepPreviewUnits, fits);
      };
      const regular = previewLine(text, column, budget.grepPreviewUnits);
      const preview = lines.length === 1 ? fitRowOne(regular) : regular;
      const shown = row(preview.text);
      if (context > 0 && column !== undefined) {
        // Without context rows, the first hit is row one and shows row one's fitted preview.
        const soloRow =
          hits.length > 0 || lines.length === 1 ? shown : row(fitRowOne(regular).text);
        hits.push({ index: lines.length, soloRow });
      }
      if (
        preview.kept !== undefined &&
        preview.kept < (previewMinimums.at(-1)?.units ?? Infinity)
      ) {
        previewMinimums.push({ index: lines.length, units: preview.kept });
      }
      lines.push(shown);
    },
    finish: () => ({
      lines,
      displayPath,
      validUtf8: snapshot.validUtf8,
      previewMinimums,
      hits,
      gapIndices,
    }),
  };
}

async function formatMatches(options: FormatMatchesOptions): Promise<{
  readonly blocks: FormattedBlocks;
  readonly matches: number;
  readonly files: number;
  /** Files left out after their second read, in result order. */
  readonly warnings: readonly SearchWarning[];
}> {
  const { cwd, files, outputMode, context, signal } = options;
  const matches = files.reduce((sum, file) => sum + file.rows.length, 0);
  // Paths and counts state the searched snapshot as is; content rows come from a second read.
  if (outputMode !== "content") {
    const rows = files.map(({ filePath, rows }) => {
      const path = serializePath(cwd, filePath);
      return outputMode === "files" ? path : `${path}: ${rows.length}`;
    });
    return { blocks: { mode: outputMode, rows }, matches, files: files.length, warnings: [] };
  }
  const blocks: ContentBlock[] = [];
  const warnings: SearchWarning[] = [];
  let fileCount = files.length;
  let shownMatches = matches;
  const results = await rereadMatches(files, context, signal, (file) =>
    contentBlock(file, options),
  );
  for (const [index, result] of results.entries()) {
    if ("warning" in result) {
      warnings.push(result.warning);
      fileCount--;
      shownMatches -= files[index].rows.length;
    } else {
      blocks.push(result.value);
    }
  }
  return {
    blocks: { mode: "content", blocks, contextRows: context > 0 },
    matches: shownMatches,
    files: fileCount,
    warnings,
  };
}

interface AssembleGrepOutputOptions {
  readonly formatted: Omit<Awaited<ReturnType<typeof formatMatches>>, "warnings">;
  readonly cwd: string;
  readonly warnings: readonly SearchWarning[];
  readonly matchLimitReached: boolean;
  readonly effectiveLimit: number;
  readonly searchFacts: SearchFacts;
  readonly budget: OutputBudgets;
}

/** A block's lines as the payload shows them: a gap row leads each row that opens a later group. */
function payloadLines({ lines, gapIndices }: ContentBlock): readonly string[] {
  if (!gapIndices.length) return lines;
  const gaps = new Set(gapIndices);
  // The gap row stays with its row, so a cut payload never ends on one.
  return lines.map((line, index) => (gaps.has(index) ? `${CONTEXT_GAP}\n${line}` : line));
}

/** Keep the longest prefix of whole rows, with any file separator attached to its header. */
function fitPayload(blocks: readonly (readonly string[])[], separated: boolean, maxBytes: number) {
  const kept: string[] = [];
  const shown: number[] = [];
  let bytes = 0;
  for (const [blockIndex, lines] of blocks.entries()) {
    shown.push(0);
    for (const [index, line] of lines.entries()) {
      const row = separated && blockIndex > 0 && index === 0 ? `\n${line}` : line;
      const cost = Buffer.byteLength(row) + (kept.length ? 1 : 0);
      if (bytes + cost > maxBytes) return { kept, shown, truncated: true };
      kept.push(row);
      bytes += cost;
      shown[blockIndex]++;
    }
  }
  return { kept, shown, truncated: false };
}

/** Would the same byte budget show more hits if context rows were removed? */
function contextHidesHit(
  blocks: readonly ContentBlock[],
  shown: readonly number[],
  maxBytes: number,
): boolean {
  let shownHits = 0;
  const hitsOnly = blocks.map(({ lines, hits }, i) => {
    // fitPayload stops at the first block that does not fit; later blocks show no rows.
    shownHits += hits.filter(({ index }) => index < (shown[i] ?? 0)).length;
    return [lines[0], ...hits.map(({ soloRow }) => soloRow)];
  });
  const withoutContext = fitPayload(hitsOnly, true, maxBytes).shown;
  return withoutContext.reduce((sum, count) => sum + Math.max(0, count - 1), 0) > shownHits;
}

/** Join the payload within the byte budget and state its limits, omissions, and diagnostics. */
function assembleGrepOutput(options: AssembleGrepOutputOptions): {
  payload: string;
  facts: SuccessFacts<"grep">;
  payloadShowsCounts?: true;
  next?: OutcomeVariant;
} {
  const { formatted, cwd, warnings, matchLimitReached, effectiveLimit, searchFacts, budget } =
    options;
  const { blocks, matches, files } = formatted;

  const blockCount = blocks.mode === "content" ? blocks.blocks.length : blocks.rows.length;
  if (!blockCount && warnings.length) {
    throw searchIncompleteError(
      "No matches could be displayed.",
      warnings,
      cwd,
      budget,
      searchFacts,
    );
  }
  const { kept, shown, truncated } =
    blocks.mode === "content"
      ? fitPayload(blocks.blocks.map(payloadLines), true, budget.grepBytes)
      : fitPayload(
          blocks.rows.map((row) => [row]),
          false,
          budget.grepBytes,
        );
  const invalidUtf8: string[] = [];
  let previewLimit: number | undefined;
  if (blocks.mode === "content")
    for (const [i, count] of shown.entries()) {
      const block = blocks.blocks[i];
      // A file shown only by its header has no preview rows.
      if (!block.validUtf8 && count > 1) invalidUtf8.push(block.displayPath);
      for (const { index, units } of block.previewMinimums) {
        if (index >= count) break;
        previewLimit = Math.min(previewLimit ?? Infinity, units);
      }
    }
  // One complete content or count block already states its path and match count.
  const countsShown = blocks.mode !== "files" && blockCount === 1 && !truncated;
  return {
    payload: kept.join("\n"),
    facts: {
      matches,
      files,
      ...searchFacts,
      matchLimit: matchLimitReached ? effectiveLimit : undefined,
      outputLimit: truncated ? formatByteSize(budget.grepBytes) : undefined,
      linePreviewLimit: previewLimit,
      invalidUtf8: invalidUtf8.length ? invalidUtf8 : undefined,
      diagnostics: warnings.length ? searchDiagnostics(warnings, cwd, budget) : undefined,
    },
    payloadShowsCounts: countsShown || undefined,
    next:
      truncated &&
      blocks.mode === "content" &&
      blocks.contextRows &&
      contextHidesHit(blocks.blocks, shown, budget.grepBytes)
        ? "contextRows"
        : undefined,
  };
}

/**
 * grep's payload and facts for a finished search. The payload is absent when nothing matched;
 * a search that cannot confirm any result fails with SEARCH_INCOMPLETE instead.
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
): Promise<{
  payload?: string;
  facts: SuccessFacts<"grep">;
  payloadShowsCounts?: true;
  next?: OutcomeVariant;
}> {
  const { cwd, search, warnings, missing, outputMode, effectiveLimit, literalPipe, budget } =
    options;
  const searchFacts: SearchFacts = {
    scanLimit: search.scanLimitReached ? formatByteSize(MAX_UNNARROWED_SCAN_BYTES) : undefined,
    missing: missing.length ? [...missing] : undefined,
  };
  if (search.files.length === 0) {
    if (warnings.length)
      throw searchIncompleteError("No matches confirmed.", warnings, cwd, budget, searchFacts);
    return {
      // A literal `|` finding nothing most likely meant alternatives.
      facts: {
        matches: 0,
        files: 0,
        ...searchFacts,
        literalPipe: literalPipe || undefined,
      },
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
    matchLimitReached: search.matchLimitReached,
    effectiveLimit,
    searchFacts,
    budget,
  });
}
