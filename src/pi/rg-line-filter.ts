import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type { Readable } from "node:stream";

export const COMMON_RG_ARGS = ["--no-config", "--color=never", "--crlf"];
export const MAX_RG_RECORD_BYTES = 16 * 1024 * 1024;

export interface SearchModes {
  engine: "default" | "pcre2";
  multiline: boolean;
  literal: boolean;
  ignoreCase: boolean;
}

export type LinePredicate = (lines: readonly Buffer[]) => Promise<boolean[]>;

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

function checkAbort(signal?: AbortSignal): void {
  if (signal?.aborted) throw new Error("Operation aborted");
}

function startRg(rgPath: string, args: readonly string[], signal?: AbortSignal): RunningProcess {
  checkAbort(signal);
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
    if (stderr.length < 65536) stderr += chunk.toString("utf8").slice(0, 65536 - stderr.length);
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
    pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
    let at: number;
    while ((at = pending.indexOf(delimiter)) !== -1) {
      if (at > MAX_RG_RECORD_BYTES) throw new Error("ripgrep output record exceeds 16 MiB");
      yield pending.subarray(0, at);
      pending = pending.subarray(at + 1);
    }
    if (pending.length > MAX_RG_RECORD_BYTES) throw new Error("ripgrep output record exceeds 16 MiB");
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
      checkAbort(signal);
      if (!await onRecord(record)) {
        stopped = true;
        process.kill();
        break;
      }
    }
    const result = await process.done;
    checkAbort(signal);
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
    record.length === 0 ? true : onLine(record.toString("utf8"))
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
    if (!Buffer.from(path, "utf8").equals(record)) throw new Error("Non-UTF-8 search paths are not supported");
    return onPath(path);
  });
}

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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
    if (bytes <= 65536) chunks.push(chunk);
    else process.kill();
  });
  process.child.stdin.end(input);
  const result = await process.done;
  checkAbort(signal);
  if (result.error) throw result.error;
  if (bytes > 65536) throw new Error("Unexpected ripgrep probe output overflow");
  return {
    code: result.code,
    stderr: result.stderr,
    stdout: Buffer.concat(chunks).toString("utf8"),
  };
};

function modeArgs(modes: Pick<SearchModes, "engine" | "multiline">): string[] {
  return [
    ...COMMON_RG_ARGS,
    `--engine=${modes.engine}`,
    modes.multiline ? "--multiline" : "--no-multiline",
  ];
}

export function matcherArgs(modes: SearchModes, word: boolean): string[] {
  return [
    ...modeArgs(modes),
    modes.ignoreCase ? "--ignore-case" : "--case-sensitive",
    ...(modes.literal ? ["--fixed-strings"] : []),
    ...(word ? ["--word-regexp"] : []),
  ];
}

function pcre2CaseCarrier(patterns: readonly string[]): string {
  return ["(?x)", ...patterns.flatMap((pattern) => pattern.split("\n").map((line) => `#${line}`)), "\\x{41}", ""].join("\n");
}

/** Resolve rg's query-level default case flag; inline regex flags still apply normally. */
export async function resolveIgnoreCase(
  rgPath: string,
  patterns: readonly string[],
  modes: Pick<SearchModes, "engine" | "multiline" | "literal">,
  explicit: boolean | undefined,
  signal?: AbortSignal,
  run: RunText = runText,
): Promise<boolean> {
  checkAbort(signal);
  if (explicit !== undefined) return explicit;
  if (patterns.length === 0) throw new Error("pattern is required (got an empty array)");

  if (modes.engine === "pcre2") {
    const version = await run(rgPath, ["--version"], Buffer.alloc(0), signal);
    if (version.code !== 0 || !/^ripgrep 15\.0\.0\b/m.test(version.stdout) || !/^features:\+pcre2$/m.test(version.stdout) || !/^PCRE2 10\.45 is available/m.test(version.stdout)) {
      throw new Error("PCRE2 smart-case is not validated for this bundled ripgrep build; set ignoreCase explicitly");
    }
    const result = await run(
      rgPath,
      [...modeArgs(modes), "--smart-case", "--quiet", "-e", pcre2CaseCarrier(patterns), "--", "-"],
      Buffer.from("a\n"),
      signal,
    );
    checkAbort(signal);
    if (result.code !== 0 && result.code !== 1) {
      throw new Error(result.stderr.trim() || `ripgrep exited with code ${result.code}`);
    }
    return result.code === 0;
  }

  const sources = patterns.map((pattern) => modes.literal ? escapeRegex(pattern) : pattern);
  const result = await run(
    rgPath,
    [
      ...modeArgs(modes),
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
  checkAbort(signal);
  if (result.code !== 0 && result.code !== 1) {
    throw new Error(result.stderr.trim() || `ripgrep exited with code ${result.code}`);
  }
  const lines = result.stdout.replace(/\r\n/g, "\n").split("\n");
  if (lines.some((line) => line !== "" && line !== "a")) throw new Error("Unexpected smart-case probe output");
  return lines.includes("a");
}

export async function validatePatterns(
  rgPath: string,
  patterns: readonly string[],
  modes: SearchModes,
  word: boolean,
  signal?: AbortSignal,
  run: RunText = runText,
): Promise<void> {
  if (modes.literal) return;
  for (const pattern of patterns) {
    const result = await run(
      rgPath,
      [...matcherArgs(modes, word), "--quiet", "-e", pattern, "--", "-"],
      Buffer.alloc(0),
      signal,
    );
    checkAbort(signal);
    if (result.code !== 0 && result.code !== 1) {
      throw new Error(result.stderr.trim() || `ripgrep exited with code ${result.code}`);
    }
  }
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

export function createLinePredicate(
  rgPath: string,
  patterns: readonly string[],
  modes: SearchModes,
  word: boolean,
  signal?: AbortSignal,
): LinePredicate {
  const args = [
    ...matcherArgs(modes, word),
    "--json",
    "--line-number",
    "--passthru",
    "--text",
    "--encoding=none",
    ...patterns.flatMap((pattern) => ["-e", pattern]),
    "--",
    "-",
  ];
  return async (lines) => {
    checkAbort(signal);
    if (lines.length === 0) return [];
    const records = lines.map((line) => {
      const firstLf = line.indexOf(10);
      if (firstLf >= 0 && firstLf !== line.length - 1) throw new Error("Expected exactly one physical candidate line");
      return firstLf >= 0 ? line : Buffer.concat([line, Buffer.from("\n")]);
    });
    const matches: boolean[] = [];
    const result = await runDelimited(rgPath, args, Buffer.concat(records), 10, signal, (record) => {
      if (record.length === 0) return true;
      const event = JSON.parse(record.toString("utf8"));
      if (event.type !== "match" && event.type !== "context") return true;
      if (event.data.line_number !== matches.length + 1) throw new Error("rg predicate line-number protocol mismatch");
      matches.push(event.type === "match");
      return true;
    });
    if (result.code !== 0 && result.code !== 1) {
      throw new Error(result.stderr.trim() || `ripgrep exited with code ${result.code}`);
    }
    if (matches.length !== lines.length) throw new Error("rg predicate ended before all responses");
    return matches;
  };
}
