import { truncateHead, formatSize, DEFAULT_MAX_BYTES } from "@earendil-works/pi-coding-agent";
import { DiagnosticBuffer } from "./diagnostic-buffer.ts";
import { createHash } from "node:crypto";
import { createAnchorFormatter, displayCarriageReturns, plainRow } from "./anchor-format.ts";
import { fileReadWarning, type RgMatch, type SearchFileSnapshot } from "./grep-search.ts";
import { scanTextFile, scanTextLines } from "./text-stream.ts";
import { GREP_MAX_LINE_LENGTH, MAX_SEARCH_DIAGNOSTIC_BYTES } from "./budgets.ts";
import { searchChangedError } from "./error-text.ts";
import { HashlineError } from "../core/errors.ts";
import { serializePath } from "./path.ts";
import { rawMatchVerifier } from "./rg-match-bytes.ts";
import type { Report } from "./report-schema.ts";

/** UTF-16 units kept before the match column when a preview window is cut. */
const GREP_PREVIEW_LEAD = 100;
const MAX_CONCURRENT_FILE_READS = 16;

/** Content-mode file header: `<path> · <N> match(es)`. parseFileHeader is its TUI parser. */
function formatFileHeader(path: string, matches: number): string {
  return `${path} · ${matches} match${matches !== 1 ? "es" : ""}`;
}
const FILE_HEADER = /^(.+?) · (\d+ match(?:es)?)$/;

export function parseFileHeader(line: string): { path: string; summary: string } | undefined {
  const match = FILE_HEADER.exec(line);
  return match ? { path: match[1], summary: match[2] } : undefined;
}

/** Distinct search diagnostics within their budget, keeping opening context and the final cause. */
function searchDiagnostics(warnings: readonly string[]): string {
  const diagnostics = new DiagnosticBuffer(MAX_SEARCH_DIAGNOSTIC_BYTES);
  for (const warning of new Set(warnings)) diagnostics.append(`${warning}\n`);
  return diagnostics.toString().trimEnd();
}

/** No result can be returned from an incomplete search: report it rather than "no matches". */
export function searchIncompleteError(
  message: string,
  warnings: readonly string[],
): HashlineError<"SEARCH_INCOMPLETE"> {
  return new HashlineError("SEARCH_INCOMPLETE", message, {
    facts: { diagnostics: searchDiagnostics(warnings) },
  });
}

function previewLine(text: string, column = 0): { text: string; wasTruncated: boolean } {
  if (text.length <= GREP_MAX_LINE_LENGTH) return { text, wasTruncated: false };
  let start = Math.max(0, Math.min(column - GREP_PREVIEW_LEAD, text.length - GREP_MAX_LINE_LENGTH));
  // Slice at UTF-16 boundaries without splitting an astral character.
  if (start > 0 && /[\uDC00-\uDFFF]/.test(text[start])) start++;
  let end = Math.min(text.length, start + GREP_MAX_LINE_LENGTH);
  if (end < text.length && /[\uDC00-\uDFFF]/.test(text[end])) end--;
  return {
    text: `[partial, columns ${start + 1}-${end}] ${start ? "…" : ""}${text.slice(start, end)}${end < text.length ? "…" : ""}`,
    wasTruncated: true,
  };
}

interface FormatMatchesOptions {
  cwd: string;
  raw: readonly RgMatch[];
  outputMode: "content" | "files" | "count";
  context: number;
  anchors: ReturnType<typeof createAnchorFormatter>;
  signal?: AbortSignal;
  warnings: string[];
  searchSnapshots: ReadonlyMap<string, SearchFileSnapshot>;
}

export async function formatMatches(options: FormatMatchesOptions) {
  const { cwd, raw, outputMode, context, anchors, signal, warnings, searchSnapshots } = options;
  const byFile = new Map<string, RgMatch[]>();
  for (const match of raw) {
    const lines = byFile.get(match.filePath) ?? [];
    lines.push(match);
    byFile.set(match.filePath, lines);
  }
  for (const lines of byFile.values()) lines.sort((a, b) => a.lineNumber - b.lineNumber);
  const formatPath = (filePath: string): string => serializePath(cwd, filePath);
  const blocks: string[] = [];
  const invalidUtf8: string[] = [];
  let linesTruncated = false;
  const fileEntries = [...byFile.entries()].filter(
    ([, matches]) => outputMode === "content" || matches.some((match) => match.rawMatch),
  );
  if (fileEntries.length) {
    const fileResults = new Array<{ block?: string; invalidUtf8?: boolean; warning?: string }>(
      fileEntries.length,
    );
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
            const verifyRaw = rawMatchVerifier(
              new Set(matchLines.flatMap((match) => (match.rawMatch ? [match.rawMatch] : []))),
            );
            try {
              if (outputMode !== "content") {
                const hash = createHash("sha256");
                await scanTextFile(
                  filePath,
                  undefined,
                  scanSignal,
                  (bytes) => {
                    hash.update(bytes);
                    verifyRaw.write(bytes);
                  },
                  "lossy",
                );
                verifyRaw.end();
                if (hash.digest("hex") !== searchSnapshots.get(filePath)!.revision)
                  throw searchChangedError();
                fileResults[current] = {};
                continue;
              }
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
              // Content-mode search snapshots every file before recording its matches.
              const snapshot = searchSnapshots.get(filePath)!;
              const stats = await scanTextLines(
                filePath,
                (number) => windowSet.has(number),
                (line) => {
                  if (line.text === undefined) return;
                  const matchedText = matchedTexts.get(line.number);
                  if (matchedText !== undefined && matchedText !== line.text) {
                    throw searchChangedError();
                  }
                  if (matchedTexts.has(line.number)) matchedRows.add(line.number);
                  const { text: display, wasTruncated } = previewLine(
                    displayCarriageReturns(line.text),
                    columns.get(line.number),
                  );
                  if (wasTruncated) linesTruncated = true;
                  rows.push(
                    snapshot.validUtf8
                      ? anchors.row(line.number, line.text, display)
                      : plainRow(line.number, display),
                  );
                },
                {
                  signal: scanSignal,
                  onBytes: (bytes) => {
                    hash.update(bytes);
                    verifyRaw.write(bytes);
                  },
                  decoding: "lossy",
                },
              );
              verifyRaw.end();
              if (stats.hasNul) throw searchChangedError();
              if (matchLines.some(({ lineNumber }) => !matchedRows.has(lineNumber))) {
                throw searchChangedError();
              }
              if (snapshot.revision !== hash.digest("hex")) {
                throw searchChangedError();
              }
              const header = `${formatFileHeader(formatPath(filePath), matchLines.length)}\n`;
              fileResults[current] = {
                block: header + rows.join("\n"),
                invalidUtf8: !snapshot.validUtf8,
              };
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
    for (const [index, result] of fileResults.entries()) {
      if (result.warning) {
        warnings.push(result.warning);
        byFile.delete(fileEntries[index][0]);
      } else if (result.block) {
        blocks.push(result.block);
        if (result.invalidUtf8) invalidUtf8.push(formatPath(fileEntries[index][0]));
      }
    }
  }
  if (outputMode === "files") {
    for (const filePath of byFile.keys()) blocks.push(formatPath(filePath));
  } else if (outputMode === "count") {
    for (const [filePath, matchLines] of byFile)
      blocks.push(`${formatPath(filePath)}: ${matchLines.length}`);
  }
  let matches = 0;
  for (const matchLines of byFile.values()) matches += matchLines.length;
  return { blocks, linesTruncated, invalidUtf8, matches, files: byFile.size };
}

/** What grep states about its outcome beside the payload rows. */
export type GrepFacts = Pick<
  Report,
  | "matches"
  | "files"
  | "matchLimit"
  | "outputLimit"
  | "linePreviewLimit"
  | "invalidUtf8"
  | "diagnostics"
>;

interface AssembleGrepOutputOptions {
  formatted: Awaited<ReturnType<typeof formatMatches>>;
  warnings: readonly string[];
  outputMode: "content" | "files" | "count";
  matchLimitReached: boolean;
  effectiveLimit: number;
}

/** Join the payload within Pi's output limit and state each limit, omission, and diagnostic once. */
export function assembleGrepOutput(options: AssembleGrepOutputOptions): {
  payload: string;
  facts: GrepFacts;
} {
  const { formatted, warnings, outputMode, matchLimitReached, effectiveLimit } = options;
  const { blocks, linesTruncated, invalidUtf8, matches, files } = formatted;

  if (!blocks.length && warnings.length) {
    throw searchIncompleteError("No matches could be displayed.", warnings);
  }
  const truncation = truncateHead(blocks.join(outputMode === "content" ? "\n\n" : "\n"), {
    maxBytes: DEFAULT_MAX_BYTES,
  });
  return {
    payload: truncation.content,
    facts: {
      matches,
      files,
      matchLimit: matchLimitReached ? effectiveLimit : undefined,
      outputLimit: truncation.truncated ? formatSize(DEFAULT_MAX_BYTES) : undefined,
      linePreviewLimit: linesTruncated ? GREP_MAX_LINE_LENGTH : undefined,
      invalidUtf8: invalidUtf8.length ? invalidUtf8 : undefined,
      diagnostics: warnings.length ? searchDiagnostics(warnings) : undefined,
    },
  };
}
