import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type { Readable } from "node:stream";
import { escapeRegex } from "../core/text.ts";
import { throwIfCancelled } from "./error-text.ts";

export const COMMON_RG_ARGS = ["--no-config", "--color=never", "--no-crlf"];
export const MAX_RG_RECORD_BYTES = 16 * 1024 * 1024;
/** Retained ripgrep stderr; diagnostics beyond this are dropped. */
export const MAX_RG_STDERR_BYTES = 64 * 1024;
/** Probe runs read only a short stdout; more means an unexpected rg mode. */
const MAX_RG_PROBE_OUTPUT_BYTES = 64 * 1024;

export interface SearchModes {
  literal: boolean;
  ignoreCase: boolean;
  multiline: boolean;
}

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

function startRg(rgPath: string, args: readonly string[], signal?: AbortSignal): RunningProcess {
  throwIfCancelled(signal);
  const env = { ...process.env };
  delete env.RIPGREP_CONFIG_PATH;
  const child = spawn(rgPath, [...args], {
    stdio: ["pipe", "pipe", "pipe"],
    shell: false,
    env,
  });
  let stderr = "";
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
    if (stderr.length < MAX_RG_STDERR_BYTES)
      stderr += chunk.toString("utf8").slice(0, MAX_RG_STDERR_BYTES - stderr.length);
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
      resolve({ code, stderr, error });
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
      if (at > MAX_RG_RECORD_BYTES) throw new Error("ripgrep output record exceeds 16 MiB");
      yield buf.subarray(0, at);
      buf = buf.subarray(at + 1);
    }
    if (buf.length > MAX_RG_RECORD_BYTES) throw new Error("ripgrep output record exceeds 16 MiB");
    pending = buf;
  }
  if (pending.length) yield pending;
}

async function runDelimited(
  rgPath: string,
  args: readonly string[],
  input: Buffer | undefined,
  delimiter: number,
  signal: AbortSignal | undefined,
  onRecord: (record: Buffer) => boolean | Promise<boolean>,
): Promise<RgRunResult> {
  const process = startRg(rgPath, args, signal);
  let stopped = false;
  process.child.stdin.end(input);
  try {
    for await (const record of delimitedRecords(process.child.stdout, delimiter)) {
      throwIfCancelled(signal);
      if (!(await onRecord(record))) {
        stopped = true;
        process.kill();
        break;
      }
    }
    const result = await process.done;
    throwIfCancelled(signal);
    if (result.error) throw new Error(`Failed to run ripgrep: ${result.error.message}`);
    return { code: result.code, stderr: result.stderr, stopped };
  } finally {
    process.kill();
    await process.done;
  }
}

/** @internal — shared process boundary for JSONL searches and regex validation. */
export function runRg(
  rgPath: string,
  args: string[],
  signal: AbortSignal | undefined,
  onLine: (line: string) => boolean | Promise<boolean>,
): Promise<RgRunResult> {
  return runDelimited(rgPath, args, undefined, 10, signal, (record) =>
    record.length === 0 ? true : onLine(record.toString("utf8")),
  );
}

/** @internal — read NUL-delimited UTF-8 paths from an owned rg process. */
export function runRgPaths(
  rgPath: string,
  args: string[],
  signal: AbortSignal | undefined,
  onPath: (path: string) => boolean | Promise<boolean>,
): Promise<RgRunResult> {
  return runDelimited(rgPath, args, undefined, 0, signal, (record) => {
    const path = record.toString("utf8");
    if (!Buffer.from(path, "utf8").equals(record))
      throw new Error("Non-UTF-8 search paths are not supported");
    return onPath(path);
  });
}

/** Accept both matches and no matches; callers handle intentional early stops separately. */
export function assertRgSucceeded(result: Pick<RgRunResult, "code" | "stderr">): void {
  if (result.code !== 0 && result.code !== 1) {
    throw new Error(result.stderr.trim() || `ripgrep exited with code ${result.code}`);
  }
}

interface TextRunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

export type RunText = (
  rgPath: string,
  args: readonly string[],
  input: Buffer,
  signal?: AbortSignal,
) => Promise<TextRunResult>;

export const runText: RunText = async (rgPath, args, input, signal) => {
  const process = startRg(rgPath, args, signal);
  const chunks: Buffer[] = [];
  let bytes = 0;
  process.child.stdout.on("data", (chunk: Buffer) => {
    bytes += chunk.length;
    if (bytes <= MAX_RG_PROBE_OUTPUT_BYTES) chunks.push(chunk);
    else process.kill();
  });
  process.child.stdin.end(input);
  const result = await process.done;
  throwIfCancelled(signal);
  if (result.error) throw result.error;
  if (bytes > MAX_RG_PROBE_OUTPUT_BYTES)
    throw new Error("Unexpected ripgrep probe output overflow");
  return {
    code: result.code,
    stderr: result.stderr,
    stdout: Buffer.concat(chunks).toString("utf8"),
  };
};

const DEFAULT_RG_MODE_ARGS = [...COMMON_RG_ARGS, "--engine=default"];

export function matcherArgs(modes: SearchModes): string[] {
  return [
    ...DEFAULT_RG_MODE_ARGS,
    modes.multiline ? "--multiline" : "--no-multiline",
    modes.ignoreCase ? "--ignore-case" : "--case-sensitive",
    ...(modes.literal ? ["--fixed-strings"] : []),
  ];
}

/** Resolve rg's query-level default case flag; inline regex flags still apply normally. */
export async function resolveIgnoreCase(
  rgPath: string,
  patterns: readonly string[],
  modes: Pick<SearchModes, "literal" | "multiline">,
  explicit: boolean | undefined,
  signal?: AbortSignal,
  run: RunText = runText,
): Promise<boolean> {
  throwIfCancelled(signal);
  if (patterns.length === 0) throw new Error("pattern is required (got an empty array)");
  if (explicit !== undefined) return explicit;

  const sources = patterns.map((pattern) => (modes.literal ? escapeRegex(pattern) : pattern));
  const result = await run(
    rgPath,
    [
      ...DEFAULT_RG_MODE_ARGS,
      modes.multiline ? "--multiline" : "--no-multiline",
      "--smart-case",
      "--encoding=none",
      "--no-heading",
      "--no-filename",
      "--no-line-number",
      "--only-matching",
      "--replace",
      "${1}",
      "-e",
      "(\\p{Lu})",
      ...sources.flatMap((pattern) => ["-e", pattern]),
      "--",
      "-",
    ],
    Buffer.from("a\n"),
    signal,
  );
  throwIfCancelled(signal);
  assertRgSucceeded(result);
  const lines = result.stdout.replace(/\r\n/g, "\n").split("\n");
  if (lines.some((line) => line !== "" && line !== "a"))
    throw new Error("Unexpected smart-case probe output");
  return lines.includes("a");
}

interface RgString {
  text?: string;
  bytes?: string;
}

export function rgBytes(value: RgString): Buffer {
  if (typeof value.text === "string") return Buffer.from(value.text, "utf8");
  if (typeof value.bytes === "string") return Buffer.from(value.bytes, "base64");
  throw new Error("Invalid rg JSON string");
}

export function rgText(value: RgString): string {
  if (typeof value.text === "string") return value.text;
  throw new Error("Non-UTF-8 search paths are not supported");
}
