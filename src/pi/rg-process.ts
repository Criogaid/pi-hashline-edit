/**
 * ripgrep process layer: spawning and cancelling rg, bounded record and
 * stderr reading, shared arguments, and the output protocols it parses.
 * Knows nothing about candidate strategy, anchors, or output formatting.
 *
 * @module pi-hashline-edit/pi
 */

import { StringDecoder } from "node:string_decoder";
import { rgPath } from "@vscode/ripgrep";
import { DiagnosticBuffer } from "./diagnostic-buffer.ts";
import { spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";
import { errnoCode, HashlineError } from "../core/errors.ts";
import { throwIfCancelled, type SearchWarning } from "./error-text.ts";
import { formatByteSize } from "./budgets.ts";

/**
 * Every rg run visits input roots in caller order and sorts each directory's entries.
 * This is deterministic traversal, not global full-path sorting. rg walks in one thread;
 * matching stays parallel in grep-search's workers.
 */
export const COMMON_RG_ARGS = ["--no-config", "--color=never", "--sort=path"];
/** Leave room for rg's arguments and paths on hosts with small command-line limits. */
export const MAX_RG_PATTERN_UNITS = 24 * 1024;
export const RG_PATTERN_FLAG = "-e";

/** Command-line cost of a translated pattern and its flag, including separators. */
export function rgPatternArgUnits(pattern: string): number {
  // Translations use ASCII without whitespace or quotes; Windows quotes an empty argument.
  return RG_PATTERN_FLAG.length + 2 + (pattern.length || 2);
}

const MAX_RG_RECORD_BYTES = 16 * 1024 * 1024;
const RG_RECORD_LIMIT_MESSAGE = `ripgrep output record exceeds ${formatByteSize(MAX_RG_RECORD_BYTES)}.`;
const NUL = 0x00;
const LF = 0x0a;

/** Bounded ripgrep stderr retains the beginning and end with an omission notice. */
const MAX_RG_STDERR_BYTES = 64 * 1024;

interface ExitResult {
  code: number | null;
  stderr: string;
  error?: Error;
}

interface RunningProcess {
  child: ChildProcessByStdio<null, Readable, Readable>;
  done: Promise<ExitResult>;
  kill(): void;
}

export interface RgRunResult {
  code: number | null;
  stderr: string;
  stopped: boolean;
}

/** An incomplete run's diagnostic, surfaced without discarding confirmed matches. */
export function searchDiagnostic(result: RgRunResult): SearchWarning | undefined {
  const reason =
    result.stderr.trim() ||
    (!result.stopped && result.code !== 0 && result.code !== 1
      ? `ripgrep exited with code ${result.code}.`
      : undefined);
  return reason ? { reason } : undefined;
}

/** spawn reports a failure to start by throwing or by an error event, depending on the errno. */
class RgStartError extends HashlineError<"RIPGREP_FAILED"> {
  constructor(cause: unknown) {
    super("RIPGREP_FAILED", "Failed to run ripgrep.", { cause });
  }
}

/** Whether rg could not start because the OS rejected its command line length. */
export function isRgArgumentLimit(error: unknown): boolean {
  if (!(error instanceof RgStartError)) return false;
  const code = errnoCode(error.cause);
  return code === "ENAMETOOLONG" || code === "E2BIG";
}

/** rg resolves `--glob` patterns against its working directory: the tool's workspace, where Pi's bash also runs. */
function startRg(args: readonly string[], cwd: string, signal: AbortSignal): RunningProcess {
  throwIfCancelled(signal);
  let child: ChildProcessByStdio<null, Readable, Readable>;
  try {
    child = spawn(rgPath, [...args], {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
    });
  } catch (cause) {
    throw new RgStartError(cause);
  }
  const stderr = new DiagnosticBuffer(MAX_RG_STDERR_BYTES);
  const stderrDecoder = new StringDecoder("utf8");
  let error: Error | undefined;
  let closed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const kill = () => {
    if (closed) return;
    child.kill("SIGTERM");
    timer ??= setTimeout(() => {
      child.kill("SIGKILL");
    }, 1000);
    timer.unref();
  };

  child.stderr.on("data", (chunk: Buffer) => {
    stderr.append(stderrDecoder.write(chunk));
  });
  child.on("error", (cause) => {
    error = cause;
  });
  const done = new Promise<ExitResult>((resolve) => {
    child.on("close", (code) => {
      closed = true;
      if (timer) clearTimeout(timer);
      signal.removeEventListener("abort", kill);
      stderr.append(stderrDecoder.end());
      resolve({ code, stderr: stderr.toString(), error });
    });
  });
  signal.addEventListener("abort", kill, { once: true });
  return { child, done, kill };
}

function checkRecordSize(bytes: number): void {
  if (bytes > MAX_RG_RECORD_BYTES)
    throw new HashlineError("RIPGREP_FAILED", RG_RECORD_LIMIT_MESSAGE);
}

async function* nulDelimitedRecords(stream: Readable): AsyncGenerator<Buffer> {
  let pending: Buffer = Buffer.alloc(0);
  for await (const value of stream) {
    const chunk = value as Buffer;
    const buf = pending.length ? Buffer.concat([pending, chunk]) : chunk;
    let at = 0;
    for (;;) {
      const end = buf.indexOf(NUL, at);
      if (end === -1) break;
      checkRecordSize(end - at);
      yield buf.subarray(at, end);
      at = end + 1;
    }
    pending = buf.subarray(at);
    checkRecordSize(pending.length);
  }
  if (pending.length) yield pending;
}

/** Run rg while read consumes its stdout; read returns false to stop rg early. */
async function runRg(
  args: readonly string[],
  cwd: string,
  signal: AbortSignal,
  read: (stdout: Readable) => Promise<boolean>,
): Promise<RgRunResult> {
  const rg = startRg(args, cwd, signal);
  try {
    const stopped = !(await read(rg.child.stdout));
    if (stopped) rg.kill();
    const result = await rg.done;
    throwIfCancelled(signal);
    if (result.error) throw new RgStartError(result.error);
    return { code: result.code, stderr: result.stderr, stopped };
  } finally {
    rg.kill();
    await rg.done;
  }
}

/** Read NUL-delimited UTF-8 paths from an owned rg process. */
export function runRgPaths(
  args: string[],
  cwd: string,
  signal: AbortSignal,
  onPath: (path: string) => boolean | Promise<boolean>,
): Promise<RgRunResult> {
  return runRg(args, cwd, signal, async (stdout) => {
    for await (const record of nulDelimitedRecords(stdout)) {
      throwIfCancelled(signal);
      if (!(await onPath(decodePath(record)))) return false;
    }
    return true;
  });
}

/**
 * Whether rg rejects pattern arguments. Exit code 2 also covers paths rg could not read, so the
 * patterns run alone against empty standard input, where only a pattern error fails.
 */
export async function rgRejectsPatterns(
  patternArgs: readonly string[],
  cwd: string,
  signal: AbortSignal,
): Promise<boolean> {
  const result = await runRg(
    [...COMMON_RG_ARGS, ...patternArgs, "--", "-"],
    cwd,
    signal,
    async (stdout) => {
      for await (const _ of stdout);
      return true;
    },
  );
  return result.code === 2;
}

/** A path rg reported; one that is not valid UTF-8 cannot be addressed by tools. */
function decodePath(record: Buffer): string {
  const path = record.toString("utf8");
  if (!Buffer.from(path, "utf8").equals(record))
    throw new HashlineError("UNSUPPORTED_PATH", "Non-UTF-8 search paths are not supported.");
  return path;
}

/** Arguments that make rg print, per file, its NUL-terminated path and matching line numbers. */
export const LINE_LISTING_ARGS = [
  "--text",
  "--null",
  "--heading",
  "--with-filename",
  "--line-number",
  "--max-columns=1",
];

/** A file's candidate lines: ascending line numbers, or every line. */
export type CandidateLines = readonly number[] | "all";

interface CandidateFile {
  path: string;
  lines: number[] | "all";
}

function collectCandidateLine(file: CandidateFile, record: Buffer, maxLines: number): void {
  if (file.lines === "all") return;
  const colon = record.indexOf(58);
  const line = colon > 0 ? Number(record.subarray(0, colon).toString("latin1")) : NaN;
  if (!Number.isSafeInteger(line) || line < 1)
    throw new HashlineError("RIPGREP_FAILED", "ripgrep printed an unexpected line record.");
  if (file.lines.length < maxLines) file.lines.push(line);
  else file.lines = "all";
}

/**
 * Read a {@link LINE_LISTING_ARGS} listing. Each file's group is a NUL-terminated
 * path, then one `N:` record per matching line ending in a line feed (its content is at most
 * one byte or an omission notice), then an empty line. onFile receives a file's ascending line
 * numbers, or "all" once there are more than maxLines.
 */
export function runRgLines(
  args: string[],
  cwd: string,
  signal: AbortSignal,
  maxLines: number,
  onFile: (path: string, lines: CandidateLines) => boolean | Promise<boolean>,
): Promise<RgRunResult> {
  return runRg(args, cwd, signal, async (stdout) => {
    let file: CandidateFile | undefined;
    let pending: Buffer = Buffer.alloc(0);
    // Records are parsed synchronously; only a completed file waits for its consumer.
    for await (const value of stdout) {
      throwIfCancelled(signal);
      const chunk = value as Buffer;
      const buf = pending.length ? Buffer.concat([pending, chunk]) : chunk;
      let at = 0;
      for (;;) {
        const end = buf.indexOf(file ? LF : NUL, at);
        if (end === -1) break;
        const record = buf.subarray(at, end);
        at = end + 1;
        if (!file) {
          file = { path: decodePath(record), lines: [] };
          continue;
        }
        if (record.length) {
          collectCandidateLine(file, record, maxLines);
          continue;
        }
        if (!(await onFile(file.path, file.lines))) return false;
        file = undefined;
      }
      pending = buf.subarray(at);
      checkRecordSize(pending.length);
    }
    if (pending.length)
      throw new HashlineError("RIPGREP_FAILED", "ripgrep printed an incomplete line record.");
    return !file || onFile(file.path, file.lines);
  });
}
