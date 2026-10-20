/**
 * grep's result: payload rows (anchored or plain previews, file headers and their TUI parser),
 * the payload budget, and every report fact grep states, including search failures.
 *
 * @module pi-hashline-edit/pi
 */
import { truncateHead } from "@earendil-works/pi-coding-agent";
import { DiagnosticBuffer } from "./diagnostic-buffer.ts";
import { createAnchorFormatter, plainRow } from "./anchor-format.ts";
import type { GrepFileMatch, searchFiles } from "./grep-search.ts";
import { MAX_UNNARROWED_SCAN_BYTES } from "./grep-candidates.ts";
import { scanTextLines } from "./text-stream.ts";
import { formatByteSize, type OutputBudgets } from "./budgets.ts";
import { fileReadWarning, searchChangedError } from "./error-text.ts";
import { HashlineError } from "../core/errors.ts";
import { serializePath } from "./path.ts";
import type { Report, SuccessFacts } from "./report-schema.ts";
import type { GrepOutputMode } from "./grep-tool.ts";

/** UTF-16 units kept before the match column when a preview window is cut. */
const GREP_PREVIEW_LEAD = 100;
const MAX_CONCURRENT_FILE_READS = 16;

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
function searchDiagnostics(warnings: readonly string[], budget: OutputBudgets): string {
  const diagnostics = new DiagnosticBuffer(budget.fieldBytes);
  for (const warning of new Set(warnings)) diagnostics.append(`${warning}\n`);
  return diagnostics.toString().trimEnd();
}

/** How the search selected and bounded its candidates; stated with success and failure alike. */
type SearchFacts = Pick<Report, "candidates" | "scanLimit">;

/** No result can be returned from an incomplete search: report it rather than "no matches". */
function searchIncompleteError(
  message: string,
  warnings: readonly string[],
  budget: OutputBudgets,
  searchFacts: SearchFacts,
): HashlineError<"SEARCH_INCOMPLETE"> {
  return new HashlineError("SEARCH_INCOMPLETE", message, {
    facts: { ...searchFacts, diagnostics: searchDiagnostics(warnings, budget) },
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
  readonly anchors: ReturnType<typeof createAnchorFormatter>;
  readonly signal?: AbortSignal;
  readonly warnings: string[];
  readonly budget: OutputBudgets;
}

interface FormattedBlock {
  readonly lines: readonly string[];
  readonly invalidUtf8?: string;
  /** Zero-based index within this block, including its file header. */
  readonly firstTruncatedLine?: number;
}

async function formatMatches(options: FormatMatchesOptions) {
  const { cwd, files, outputMode, context, anchors, signal, warnings, budget } = options;
  const formatPath = (filePath: string): string => serializePath(cwd, filePath);
  const blocks: FormattedBlock[] = [];
  // Paths and counts state the searched snapshot as is. Content rows come from a second read,
  // which must match the revision the search matched; a file that changed is left out.
  let fileCount = files.length;
  let matches = files.reduce((sum, file) => sum + file.rows.length, 0);
  if (outputMode === "content" && files.length) {
    const fileResults = new Array<{
      block?: FormattedBlock;
      warning?: string;
    }>(files.length);
    let nextIndex = 0;
    const workerAbort = new AbortController();
    const scanSignal = signal ? AbortSignal.any([signal, workerAbort.signal]) : workerAbort.signal;
    let failure: { error: unknown } | undefined;
    const workers = Array.from(
      { length: Math.min(MAX_CONCURRENT_FILE_READS, files.length) },
      async () => {
        try {
          while (!workerAbort.signal.aborted && nextIndex < files.length) {
            const current = nextIndex++;
            const { filePath, rows: matchLines, snapshot } = files[current];
            try {
              const columns = new Map(matchLines.map((match) => [match.lineNumber, match.column]));
              const windowSet = new Set<number>();
              for (const { lineNumber } of matchLines) {
                for (let n = Math.max(1, lineNumber - context); n <= lineNumber + context; n++)
                  windowSet.add(n);
              }
              const displayPath = formatPath(filePath);
              const lines = [formatFileHeader(displayPath, matchLines.length)];
              let firstTruncatedLine: number | undefined;
              const stats = await scanTextLines(
                filePath,
                (number) => windowSet.has(number),
                (line) => {
                  if (line.text === undefined) return;
                  // Rows make CR visible one unit for one, so preview columns stay source columns.
                  const { text: display, wasTruncated } = previewLine(
                    line.text,
                    columns.get(line.number),
                    budget.grepPreviewUnits,
                  );
                  if (wasTruncated) firstTruncatedLine ??= lines.length;
                  lines.push(
                    snapshot.validUtf8
                      ? anchors.row(line.number, line.text, display)
                      : plainRow(line.number, display),
                  );
                },
                {
                  signal: scanSignal,
                  decoding: "lossy",
                },
              );
              if (stats.hasNul) throw searchChangedError();
              if (snapshot.revision !== stats.revision) {
                throw searchChangedError();
              }
              fileResults[current] = {
                block: {
                  lines,
                  invalidUtf8: snapshot.validUtf8 ? undefined : displayPath,
                  firstTruncatedLine,
                },
              };
            } catch (error) {
              const warning = fileReadWarning(filePath, error, scanSignal);
              if (!warning) throw error;
              fileResults[current] = { warning };
            }
          }
        } catch (error) {
          failure ??= { error };
          workerAbort.abort();
        }
      },
    );
    await Promise.all(workers);
    if (failure) throw failure.error;
    for (const [index, result] of fileResults.entries()) {
      if (result.warning) {
        warnings.push(result.warning);
        fileCount--;
        matches -= files[index].rows.length;
      } else if (result.block) {
        blocks.push(result.block);
      }
    }
  }
  if (outputMode === "files") {
    for (const { filePath } of files) blocks.push({ lines: [formatPath(filePath)] });
  } else if (outputMode === "count") {
    for (const { filePath, rows } of files)
      blocks.push({ lines: [`${formatPath(filePath)}: ${rows.length}`] });
  }
  return { blocks, matches, files: fileCount };
}

interface AssembleGrepOutputOptions {
  readonly formatted: Awaited<ReturnType<typeof formatMatches>>;
  readonly warnings: readonly string[];
  readonly outputMode: GrepOutputMode;
  readonly matchLimitReached: boolean;
  readonly effectiveLimit: number;
  readonly searchFacts?: SearchFacts;
  readonly budget: OutputBudgets;
}

/** Join the payload within the call's byte budget and state each limit, omission, and diagnostic once. */
export function assembleGrepOutput(options: AssembleGrepOutputOptions): {
  payload: string;
  facts: SuccessFacts<"grep">;
} {
  const {
    formatted,
    warnings,
    outputMode,
    matchLimitReached,
    effectiveLimit,
    searchFacts = {},
    budget,
  } = options;
  const { blocks, matches, files } = formatted;

  if (!blocks.length && warnings.length) {
    throw searchIncompleteError("No matches could be displayed.", warnings, budget, searchFacts);
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
      diagnostics: warnings.length ? searchDiagnostics(warnings, budget) : undefined,
    },
  };
}

/**
 * grep's payload and report facts for a finished search. The payload is absent when nothing
 * matched; a search that cannot confirm any result fails with SEARCH_INCOMPLETE instead.
 */
export async function grepOutput(
  options: Omit<FormatMatchesOptions, "files"> & {
    readonly search: Awaited<ReturnType<typeof searchFiles>>;
    readonly effectiveLimit: number;
    /** A literal pattern contains `|`, which matches only that character. */
    readonly literalPipe: boolean;
  },
): Promise<{ payload?: string; facts: SuccessFacts<"grep"> }> {
  const { search, warnings, outputMode, effectiveLimit, literalPipe, budget } = options;
  const searchFacts: SearchFacts = {
    candidates: search.candidates === "lines" ? undefined : search.candidates,
    scanLimit: search.scanLimitReached ? formatByteSize(MAX_UNNARROWED_SCAN_BYTES) : undefined,
  };
  if (search.files.length === 0) {
    if (warnings.length)
      throw searchIncompleteError("No matches confirmed.", warnings, budget, searchFacts);
    return {
      // A literal `|` finding nothing most likely meant alternatives.
      facts: { matches: 0, files: 0, ...searchFacts, literalPipe: literalPipe || undefined },
    };
  }
  const formatted = await formatMatches({ ...options, files: search.files, budget });
  return assembleGrepOutput({
    formatted,
    warnings,
    outputMode,
    matchLimitReached: search.matchLimitReached,
    effectiveLimit,
    searchFacts,
    budget,
  });
}
