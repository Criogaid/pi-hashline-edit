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

interface OutputBlock {
  readonly lines: readonly string[];
  readonly matches: number;
}

/** Row indices count from the header at 0. A gap and its following row fit together. */
interface ContentBlock extends OutputBlock {
  readonly invalidPath?: string;
  /** Rows that establish a narrower displayed preview. */
  readonly previewMinimums: readonly PreviewMinimum[];
  /** Hits and their display rows if context is removed. */
  readonly hits: readonly { readonly index: number; readonly soloRow: string }[];
}

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
  let previousLine = 0;
  return {
    onLine(number, text) {
      // Rows make CR visible one unit for one, so preview columns stay source columns.
      const column = columns.get(number);
      const gap = context > 0 && previousLine !== 0 && number > previousLine + 1;
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
      lines.push(gap ? `${CONTEXT_GAP}\n${shown}` : shown);
    },
    finish: () => ({
      lines,
      matches: rows.length,
      invalidPath: snapshot.validUtf8 ? undefined : displayPath,
      previewMinimums,
      hits,
    }),
  };
}

async function formatMatches(options: FormatMatchesOptions): Promise<
  | {
      readonly mode: "content";
      readonly blocks: readonly ContentBlock[];
      readonly warnings: readonly SearchWarning[];
    }
  | {
      readonly mode: Exclude<GrepOutputMode, "content">;
      readonly blocks: readonly OutputBlock[];
      readonly warnings: readonly [];
    }
> {
  const { cwd, files, outputMode, context, signal } = options;
  // Paths and counts state the searched snapshot as is; content rows come from a second read.
  if (outputMode !== "content") {
    const blocks = files.map(({ filePath, rows }) => {
      const path = serializePath(cwd, filePath);
      const matches = rows.length;
      return { lines: [outputMode === "files" ? path : `${path}: ${matches}`], matches };
    });
    return { mode: outputMode, blocks, warnings: [] };
  }
  const blocks: ContentBlock[] = [];
  const warnings: SearchWarning[] = [];
  const results = await rereadMatches(files, context, signal, (file) =>
    contentBlock(file, options),
  );
  for (const result of results) {
    if ("warning" in result) warnings.push(result.warning);
    else blocks.push(result.value);
  }
  return { mode: outputMode, blocks, warnings };
}

/** Fit whole rows, including any blank separator that belongs to a file header. */
function fitPayload(blocks: Iterable<Iterable<string>>, separator: string, maxBytes: number) {
  const kept: string[] = [];
  const shown: number[] = [];
  let bytes = 0;
  for (const lines of blocks) {
    let prefix = kept.length ? separator : "";
    const start = kept.length;
    for (const line of lines) {
      bytes += Buffer.byteLength(line) + prefix.length;
      if (bytes > maxBytes) {
        shown.push(kept.length - start);
        return { kept, shown, truncated: true };
      }
      kept.push(prefix + line);
      prefix = "\n";
    }
    shown.push(kept.length - start);
  }
  return { kept, shown, truncated: false };
}

/** Without context, the first hit under each header uses the fitted first-row preview. */
function* hitRows({ lines, hits }: ContentBlock) {
  yield lines[0];
  for (const { soloRow } of hits) yield soloRow;
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
  const { cwd, search, warnings, missing, context, effectiveLimit, literalPipe, budget } = options;
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
  const {
    mode,
    blocks,
    warnings: rereadWarnings,
  } = await formatMatches({
    ...options,
    files: search.files,
  });
  const diagnostics = [...warnings, ...rereadWarnings];
  if (!blocks.length && diagnostics.length)
    throw searchIncompleteError(
      "No matches could be displayed.",
      diagnostics,
      cwd,
      budget,
      searchFacts,
    );

  const separator = mode === "content" ? "\n\n" : "\n";
  const { kept, shown, truncated } = fitPayload(
    blocks.map(({ lines }) => lines),
    separator,
    budget.grepBytes,
  );
  const invalidUtf8: string[] = [];
  let previewLimit = Infinity;
  let shownHits = 0;
  let next: OutcomeVariant | undefined;
  if (mode === "content") {
    for (const [index, count] of shown.entries()) {
      // A file shown only by its header has no preview rows.
      if (count <= 1) continue;
      const block = blocks[index];
      if (block.invalidPath !== undefined) invalidUtf8.push(block.invalidPath);
      const minimum = block.previewMinimums.findLast(({ index }) => index < count);
      previewLimit = Math.min(previewLimit, minimum?.units ?? Infinity);
      shownHits += block.hits.findLastIndex(({ index }) => index < count) + 1;
    }
    if (truncated && context > 0) {
      const withoutContext = fitPayload(blocks.map(hitRows), separator, budget.grepBytes).shown;
      const hitCount = withoutContext.reduce((sum, count) => sum + Math.max(0, count - 1), 0);
      if (hitCount > shownHits) next = "contextRows";
    }
  }
  return {
    payload: kept.join(""),
    facts: {
      matches: blocks.reduce((sum, block) => sum + block.matches, 0),
      files: blocks.length,
      ...searchFacts,
      matchLimit: search.matchLimitReached ? effectiveLimit : undefined,
      outputLimit: truncated ? formatByteSize(budget.grepBytes) : undefined,
      linePreviewLimit: previewLimit === Infinity ? undefined : previewLimit,
      invalidUtf8: invalidUtf8.length ? invalidUtf8 : undefined,
      diagnostics: diagnostics.length ? searchDiagnostics(diagnostics, cwd, budget) : undefined,
    },
    // One complete content or count block already states its path and match count.
    payloadShowsCounts: (!truncated && blocks.length === 1 && mode !== "files") || undefined,
    next,
  };
}
