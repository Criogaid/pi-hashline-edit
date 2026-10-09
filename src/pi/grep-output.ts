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

/** UTF-16 units kept before the match column when a preview window is cut. */
const GREP_PREVIEW_LEAD = 100;
const MAX_CONCURRENT_FILE_READS = 16;
const INVALID_UTF8_PREVIEW_NOTICE =
  "Invalid UTF-8: replacement characters shown; plain line numbers cannot be used as edit anchors";

/** Content-mode file header: `<path> · <N> match(es)`. parseFileHeader is its TUI parser. */
function formatFileHeader(path: string, matches: number): string {
  return `${path} · ${matches} match${matches !== 1 ? "es" : ""}`;
}
const FILE_HEADER = /^(.+?) · (\d+ match(?:es)?)$/;

export function parseFileHeader(line: string): { path: string; summary: string } | undefined {
  const match = FILE_HEADER.exec(line);
  return match ? { path: match[1], summary: match[2] } : undefined;
}

/** Notices and search diagnostics open with `[` (see assembleGrepOutput and formatSearchWarnings). */
export function isNoticeLine(line: string): boolean {
  return line.startsWith("[");
}

/** Distinct search diagnostics within their budget, keeping opening context and the final cause. */
function searchDiagnostics(warnings: readonly string[]): string {
  const diagnostics = new DiagnosticBuffer(MAX_SEARCH_DIAGNOSTIC_BYTES);
  for (const warning of new Set(warnings)) diagnostics.append(`${warning}\n`);
  return diagnostics.toString().trimEnd();
}

export function formatSearchWarnings(warnings: readonly string[]): string {
  if (!warnings.length) return "";
  return `\n\n[Search incomplete; results and counts cover only confirmed matches.\n${searchDiagnostics(warnings)}]`;
}

/** No result can be returned from an incomplete search: report it rather than "no matches". */
export function searchIncompleteError(message: string, warnings: readonly string[]): HashlineError {
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
  let linesTruncated = false;
  const fileEntries = [...byFile.entries()].filter(
    ([, matches]) => outputMode === "content" || matches.some((match) => match.rawMatch),
  );
  if (fileEntries.length) {
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
              const notice = snapshot.validUtf8 ? "" : `\n[${INVALID_UTF8_PREVIEW_NOTICE}]`;
              fileResults[current] = { block: header + rows.join("\n") + notice };
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
      } else if (result.block) blocks.push(result.block);
    }
  }
  if (outputMode === "files") {
    for (const filePath of byFile.keys()) blocks.push(formatPath(filePath));
  } else if (outputMode === "count" && byFile.size) {
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
  matchLimitReached: boolean;
  effectiveLimit: number;
  linesTruncated: boolean;
}

export function assembleGrepOutput(options: AssembleGrepOutputOptions): {
  content: [{ type: "text"; text: string }];
  details: { incomplete: true } | undefined;
} {
  const { blocks, warnings, outputMode, matchLimitReached, effectiveLimit, linesTruncated } =
    options;

  if (!blocks.length && warnings.length) {
    throw searchIncompleteError("No matches could be displayed.", warnings);
  }
  let output = blocks.join(outputMode === "content" ? "\n\n" : "\n");
  const truncation = truncateHead(output, { maxBytes: DEFAULT_MAX_BYTES });
  output = truncation.content;

  const notices: string[] = [];
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
