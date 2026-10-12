/**
 * ripgrep process layer: spawning and cancelling rg, bounded record and
 * stderr reading, shared arguments, and the candidate-file listing arguments.
 * Knows nothing about anchors or output formatting.
 *
 * @module pi-hashline-edit/pi
 */

import { StringDecoder } from "node:string_decoder";
import { DiagnosticBuffer } from "./diagnostic-buffer.ts";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type { Readable } from "node:stream";
import { HashlineError } from "../core/errors.ts";
import { throwIfCancelled } from "./error-text.ts";
import type { Literal, Prefilter } from "../core/search-analysis.ts";

export const COMMON_RG_ARGS = ["--no-config", "--color=never"];
export const MAX_RG_RECORD_BYTES = 16 * 1024 * 1024;
const RG_RECORD_LIMIT_MESSAGE = `ripgrep output record exceeds ${MAX_RG_RECORD_BYTES / 1024 ** 2} MiB.`;
/**
 * A ripgrep process or output-protocol failure. A finished run contributes its
 * exit code and, as the cause, its stderr.
 */
export function ripgrepFailure(
  message: string,
  run?: { readonly code: number | null; readonly stderr: string } | { readonly error: unknown },
): HashlineError<"RIPGREP_FAILED"> {
  if (run === undefined) return new HashlineError("RIPGREP_FAILED", message);
  if ("error" in run) return new HashlineError("RIPGREP_FAILED", message, { cause: run.error });
  const stderr = run.stderr.trim();
  return new HashlineError("RIPGREP_FAILED", message, {
    facts: { exitCode: run.code },
    ...(stderr ? { cause: stderr } : {}),
  });
}

/** rg reported a path that is not valid UTF-8; tools cannot address it. */
function unsupportedPath(): HashlineError {
  return new HashlineError("UNSUPPORTED_PATH", "Non-UTF-8 search paths are not supported.");
}

/** Bounded ripgrep stderr retains the beginning and end with an omission notice. */
export const MAX_RG_STDERR_BYTES = 64 * 1024;

interface ExitResult {
  code: number | null;
  stderr: string;
  error?: Error;
}

interface RunningProcess {
  child: ChildProcessWithoutNullStreams;
  done: Promise<ExitResult>;
  kill(): void;
}

export interface RgRunResult {
  code: number | null;
  stderr: string;
  stopped: boolean;
}

/** @internal — injectable process boundary for deterministic tests. */
export interface GrepBackend {
  runRgPaths: typeof runRgPaths;
  runRgLines: typeof runRgLines;
}

/** Surface incomplete search diagnostics without discarding confirmed matches. */
export function recordSearchDiagnostics(result: RgRunResult, warnings: string[]): void {
  const message =
    result.stderr.trim() ||
    (!result.stopped && result.code !== 0 && result.code !== 1
      ? `ripgrep exited with code ${result.code}.`
      : "");
  if (message) warnings.push(message);
}

function startRg(rgPath: string, args: readonly string[], signal?: AbortSignal): RunningProcess {
  throwIfCancelled(signal);
  const env = { ...process.env };
  delete env.RIPGREP_CONFIG_PATH;
  const child = spawn(rgPath, [...args], {
    stdio: ["pipe", "pipe", "pipe"],
    shell: false,
    env,
  });
  const stderr = new DiagnosticBuffer(MAX_RG_STDERR_BYTES);
  const stderrDecoder = new StringDecoder("utf8");
  let error: Error | undefined;
  let closed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const kill = () => {
    if (closed) return;
    child.kill("SIGTERM");
    timer ??= setTimeout(() => {
      if (!closed) child.kill("SIGKILL");
    }, 1000);
    timer.unref();
  };

  child.stderr.on("data", (chunk: Buffer) => {
    stderr.append(stderrDecoder.write(chunk));
  });
  child.on("error", (cause) => {
    error = cause;
  });
  child.stdin.on("error", (cause: NodeJS.ErrnoException) => {
    if (cause.code !== "EPIPE") {
      error = cause;
      kill();
    }
  });
  const done = new Promise<ExitResult>((resolve) => {
    child.on("close", (code) => {
      closed = true;
      if (timer) clearTimeout(timer);
      signal?.removeEventListener("abort", kill);
      stderr.append(stderrDecoder.end());
      resolve({ code, stderr: stderr.toString(), error });
    });
  });
  signal?.addEventListener("abort", kill, { once: true });
  if (signal?.aborted) kill();
  return { child, done, kill };
}

async function* delimitedRecords(stream: Readable, delimiter: number): AsyncGenerator<Buffer> {
  let pending = Buffer.alloc(0);
  for await (const value of stream) {
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
    // Fast path: no pending data — search the chunk directly.
    let buf = pending.length ? Buffer.concat([pending, chunk]) : chunk;
    pending = Buffer.alloc(0);
    let at: number;
    while ((at = buf.indexOf(delimiter)) !== -1) {
      if (at > MAX_RG_RECORD_BYTES) throw ripgrepFailure(RG_RECORD_LIMIT_MESSAGE);
      yield buf.subarray(0, at);
      buf = buf.subarray(at + 1);
    }
    if (buf.length > MAX_RG_RECORD_BYTES) throw ripgrepFailure(RG_RECORD_LIMIT_MESSAGE);
    pending = buf;
  }
  if (pending.length) yield pending;
}

/** Run rg while read consumes its stdout; read returns false to stop rg early. */
async function runRg(
  rgPath: string,
  args: readonly string[],
  input: Buffer | undefined,
  signal: AbortSignal | undefined,
  read: (stdout: Readable) => Promise<boolean>,
): Promise<RgRunResult> {
  const process = startRg(rgPath, args, signal);
  process.child.stdin.end(input);
  try {
    const stopped = !(await read(process.child.stdout));
    if (stopped) process.kill();
    const result = await process.done;
    throwIfCancelled(signal);
    if (result.error) throw ripgrepFailure("Failed to run ripgrep.", { error: result.error });
    return { code: result.code, stderr: result.stderr, stopped };
  } finally {
    process.kill();
    await process.done;
  }
}

function runDelimited(
  rgPath: string,
  args: readonly string[],
  input: Buffer | undefined,
  delimiter: number,
  signal: AbortSignal | undefined,
  onRecord: (record: Buffer) => boolean | Promise<boolean>,
): Promise<RgRunResult> {
  return runRg(rgPath, args, input, signal, async (stdout) => {
    for await (const record of delimitedRecords(stdout, delimiter)) {
      throwIfCancelled(signal);
      if (!(await onRecord(record))) return false;
    }
    return true;
  });
}

/** @internal — read NUL-delimited UTF-8 paths from an owned rg process. */
export function runRgPaths(
  rgPath: string,
  args: string[],
  signal: AbortSignal | undefined,
  onPath: (path: string) => boolean | Promise<boolean>,
): Promise<RgRunResult> {
  return runDelimited(rgPath, args, undefined, 0, signal, (record) => onPath(decodePath(record)));
}

function decodePath(record: Buffer): string {
  const path = record.toString("utf8");
  if (!Buffer.from(path, "utf8").equals(record)) throw unsupportedPath();
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

/**
 * @internal — read a {@link LINE_LISTING_ARGS} listing. Each file's group is a NUL-terminated
 * path, then one `N:` record per matching line ending in a line feed (its content is at most
 * one byte or an omission notice), then an empty line. onFile receives a file's ascending line
 * numbers, or undefined once there are more than maxLines.
 */
export function runRgLines(
  rgPath: string,
  args: string[],
  signal: AbortSignal | undefined,
  maxLines: number,
  onFile: (path: string, lines: readonly number[] | undefined) => boolean | Promise<boolean>,
): Promise<RgRunResult> {
  return runRg(rgPath, args, undefined, signal, async (stdout) => {
    let path: string | undefined;
    let lines: number[] | undefined = [];
    let pending: Buffer = Buffer.alloc(0);
    const flush = () => {
      const found = lines;
      const file = path!;
      path = undefined;
      lines = [];
      return onFile(file, found);
    };
    // Records are parsed synchronously; only a completed file waits for its consumer.
    for await (const value of stdout) {
      throwIfCancelled(signal);
      const chunk = value as Buffer;
      const buf = pending.length ? Buffer.concat([pending, chunk]) : chunk;
      let at = 0;
      for (;;) {
        const end = buf.indexOf(path === undefined ? 0 : 10, at);
        if (end === -1) break;
        const record = buf.subarray(at, end);
        at = end + 1;
        if (path === undefined) path = decodePath(record);
        else if (!record.length) {
          if (!(await flush())) return false;
        } else if (lines) {
          const colon = record.indexOf(58);
          const line = colon > 0 ? Number(record.subarray(0, colon).toString("latin1")) : NaN;
          if (!Number.isSafeInteger(line) || line < 1)
            throw ripgrepFailure("ripgrep printed an unexpected line record.");
          if (lines.length < maxLines) lines.push(line);
          else lines = undefined;
        }
      }
      pending = buf.subarray(at);
      if (pending.length > MAX_RG_RECORD_BYTES) throw ripgrepFailure(RG_RECORD_LIMIT_MESSAGE);
    }
    if (pending.length) throw ripgrepFailure("ripgrep printed an incomplete line record.");
    return path === undefined || flush();
  });
}

/** Accept both matches and no matches; callers handle intentional early stops separately. */
export function assertRgSucceeded(result: Pick<RgRunResult, "code" | "stderr">): void {
  if (result.code !== 0 && result.code !== 1) throw ripgrepFailure("ripgrep failed.", result);
}

/** A literal's characters as one rg pattern; every non-word character is a code point escape. */
function literalPattern(literal: Literal): string {
  const escape = (char: string) =>
    /^[0-9A-Za-z_]$/.test(char) ? char : `\\x{${char.codePointAt(0)!.toString(16)}}`;
  return literal
    .map((chars) => (chars.length === 1 ? escape(chars[0]) : `[${chars.map(escape).join("")}]`))
    .join("");
}

/**
 * List candidate files: those whose original bytes contain a prefilter literal, or every
 * file in scope. Literals never contain a line break, so line-oriented matching finds them.
 */
export function candidateArgs(prefilter: Prefilter): string[] {
  if (prefilter.kind === "and") return candidateArgs(prefilter.filters[0]);
  if (prefilter.kind === "all") return [...COMMON_RG_ARGS, "--files"];
  return [
    ...COMMON_RG_ARGS,
    "--files-with-matches",
    "--engine=default",
    "--case-sensitive",
    "--encoding=none",
    "-e",
    prefilter.literals.map(literalPattern).join("|"),
  ];
}

/** Maximum retained paths while intersecting necessary file conditions. */
export const MAX_PREFILTER_PATH_BYTES = 4 * 1024 * 1024;

/** Execute AND-of-OR file conditions, falling back to one necessary clause if retention fills. */
export async function runCandidatePaths(
  run: typeof runRgPaths,
  rgPath: string,
  prefilter: Prefilter,
  scopedArgs: readonly string[],
  signal: AbortSignal | undefined,
  onFile: (path: string) => boolean | Promise<boolean>,
): Promise<RgRunResult> {
  const filters = prefilter.kind === "and" ? prefilter.filters : [prefilter];
  const diagnostics = new DiagnosticBuffer(MAX_RG_STDERR_BYTES);
  let allowed: ReadonlySet<string> | undefined;
  for (const [index, filter] of filters.entries()) {
    const last = index === filters.length - 1;
    const paths = new Set<string>();
    let bytes = 0;
    let overflow = false;
    const result = await run(
      rgPath,
      [...candidateArgs(filter), "--null", ...scopedArgs],
      signal,
      async (path) => {
        if (allowed && !allowed.has(path)) return true;
        if (last) return onFile(path);
        if (!paths.has(path)) {
          paths.add(path);
          bytes += Buffer.byteLength(path);
        }
        overflow = bytes > MAX_PREFILTER_PATH_BYTES;
        return !overflow;
      },
    );
    if (result.stderr) diagnostics.append(`${result.stderr}\n`);
    if (overflow) {
      const fallback = await run(
        rgPath,
        [...candidateArgs(filters[0]), "--null", ...scopedArgs],
        signal,
        onFile,
      );
      if (fallback.stderr) diagnostics.append(fallback.stderr);
      return { ...fallback, stderr: diagnostics.toString() };
    }
    if (last || result.stopped || (result.code !== 0 && result.code !== 1)) {
      // An incomplete intermediate listing cannot exclude its already reported candidates.
      if (!last) for (const path of paths) if (!(await onFile(path))) break;
      return { ...result, stderr: diagnostics.toString() };
    }
    if (!paths.size) return { code: 1, stderr: diagnostics.toString(), stopped: false };
    allowed = paths;
  }
  return { code: 1, stderr: diagnostics.toString(), stopped: false };
}
