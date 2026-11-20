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
import { serializeAbsolutePath, serializePath } from "./path.ts";
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

/**
 * A success's search facts, its missing paths spelled as headers spell paths. A failure keeps
 * them resolved, because describeFailure spells every failure's missing paths.
 */
function statedSearchFacts(facts: SearchFacts): SearchFacts {
  return { ...facts, missing: facts.missing?.map(serializeAbsolutePath) };
}

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
  if (start > 0 && LOW_SURROGATE.test(text[start])) start++;
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
  readonly signal?: AbortSignal;
  readonly budget: OutputBudgets;
}

interface FormattedBlock {
  readonly lines: readonly string[];
  readonly invalidUtf8?: string;
  /** Indices of hits in a block with context rows. */
  readonly hitIndices?: readonly number[];
  /** Indices of rows that open a group after a gap in line numbers, in a block with context rows. */
  readonly gapIndices?: readonly number[];
  /** The first hit's row fitted as row one, when another row precedes it. */
  readonly firstHitRow?: string;
  /** Rows that establish a narrower displayed preview, indexed from the file header. */
  readonly previewMinimums?: readonly { index: number; units: number }[];
}

/**
 * One file's content block: its header, then a row for each line the second read shows. The
 * first row is narrowed to the space remaining after its header.
 */
function contentBlock(
  { filePath, rows, snapshot }: GrepFileMatch,
  { cwd, anchors, budget, context }: FormatMatchesOptions,
): LineCollector<FormattedBlock> {
  const columns = new Map(rows.map((match) => [match.lineNumber, match.column]));
  const displayPath = serializePath(cwd, filePath);
  const header = formatFileHeader(displayPath, rows.length);
  const lines = [header];
  const firstRowBytes = budget.grepBytes - Buffer.byteLength(header) - 1;
  const previewMinimums: { index: number; units: number }[] = [];
  const hitIndices: number[] | undefined = context > 0 ? [] : undefined;
  const gapIndices: number[] | undefined = context > 0 ? [] : undefined;
  let previousLine: number | undefined;
  let firstHitRow: string | undefined;
  return {
    onLine(number, text) {
      // Rows make CR visible one unit for one, so preview columns stay source columns.
      const column = columns.get(number);
      if (previousLine !== undefined && number > previousLine + 1) gapIndices?.push(lines.length);
      previousLine = number;
      const row = (display: string) =>
        snapshot.validUtf8 ? anchors.row(number, text, display) : plainRow(number, display);
      let preview = previewLine(text, column, budget.grepPreviewUnits);
      const firstHit = hitIndices?.length === 0 && column !== undefined;
      if (lines.length === 1 || firstHit) {
        // A row is its prefix followed by the CR-visible preview.
        const prefixBytes = Buffer.byteLength(row(""));
        const rowBytes = (candidate: Preview) =>
          prefixBytes + Buffer.byteLength(displayCarriageReturns(candidate.text));
        const fits = (candidate: Preview) => rowBytes(candidate) <= firstRowBytes;
        const fitted = fits(preview)
          ? preview
          : narrowPreview(text, column, budget.grepPreviewUnits, fits);
        // Row one shows the fitted preview. A later first hit keeps its regular preview here and
        // records the row it would show as row one once context rows are removed.
        if (lines.length === 1) preview = fitted;
        else firstHitRow = row(fitted.text);
      }
      if (column !== undefined) hitIndices?.push(lines.length);
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
      hitIndices,
      gapIndices,
      firstHitRow,
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

/** A block's lines as the payload shows them: a gap row leads each row that opens a later group. */
function payloadLines({ lines, gapIndices }: FormattedBlock): readonly string[] {
  if (!gapIndices?.length) return lines;
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
  blocks: readonly FormattedBlock[],
  shown: readonly number[],
  maxBytes: number,
): boolean {
  let shownHits = 0;
  const hitsOnly: string[][] = [];
  for (const [i, { lines, hitIndices, firstHitRow }] of blocks.entries()) {
    if (!hitIndices) return false;
    shownHits += hitIndices.filter((index) => index < (shown[i] ?? 0)).length;
    hitsOnly.push([
      lines[0],
      firstHitRow ?? lines[hitIndices[0]],
      ...hitIndices.slice(1).map((index) => lines[index]),
    ]);
  }
  const withoutContext = fitPayload(hitsOnly, true, maxBytes).shown;
  return withoutContext.reduce((sum, count) => sum + Math.max(0, count - 1), 0) > shownHits;
}

/**
 * Join the payload within the call's byte budget and state each limit, omission, and diagnostic
 * once. `implied` holds the counts the payload already shows, which the report leaves out.
 */
function assembleGrepOutput(options: AssembleGrepOutputOptions): {
  payload: string;
  facts: SuccessFacts<"grep">;
  implied?: Partial<SuccessFacts<"grep">>;
  next?: OutcomeVariant;
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
  const { kept, shown, truncated } = fitPayload(
    blocks.map(payloadLines),
    outputMode === "content",
    budget.grepBytes,
  );
  const invalidUtf8: string[] = [];
  let previewLimit: number | undefined;
  for (const [i, count] of shown.entries()) {
    const block = blocks[i];
    // A file shown only by its header has no preview rows.
    if (block.invalidUtf8 && count > 1) invalidUtf8.push(block.invalidUtf8);
    for (const { index, units } of block.previewMinimums ?? []) {
      if (index >= count) break;
      previewLimit = Math.min(previewLimit ?? Infinity, units);
    }
  }
  // One complete content or count block already states its path and match count.
  const countsShown = outputMode !== "files" && blocks.length === 1 && !truncated;
  return {
    payload: kept.join("\n"),
    facts: {
      ...(countsShown ? {} : { matches, files }),
      ...statedSearchFacts(searchFacts),
      matchLimit: matchLimitReached ? effectiveLimit : undefined,
      outputLimit: truncated ? formatByteSize(budget.grepBytes) : undefined,
      linePreviewLimit: previewLimit,
      invalidUtf8: invalidUtf8.length ? invalidUtf8 : undefined,
      diagnostics: warnings.length ? searchDiagnostics(warnings, cwd, budget) : undefined,
    },
    implied: countsShown ? { matches, files } : undefined,
    next: truncated && contextHidesHit(blocks, shown, budget.grepBytes) ? "contextRows" : undefined,
  };
}

/**
 * grep's payload and report facts for a finished search, with the counts the payload already
 * shows as `implied`. The payload is absent when nothing matched; a search that cannot confirm
 * any result fails with SEARCH_INCOMPLETE instead.
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
  implied?: Partial<SuccessFacts<"grep">>;
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
        ...statedSearchFacts(searchFacts),
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
    outputMode,
    matchLimitReached: search.matchLimitReached,
    effectiveLimit,
    searchFacts,
    budget,
  });
}
