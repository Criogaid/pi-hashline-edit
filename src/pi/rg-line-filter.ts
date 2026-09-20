import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";

export const BASE_RG_ARGS = ["--no-config", "--engine=default", "--no-multiline", "--color=never", "--crlf"];

export interface SearchModes {
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

/** @internal — shared process boundary for searches and regex validation. */
export async function runRg(
  rgPath: string,
  args: string[],
  signal: AbortSignal | undefined,
  onLine: (line: string) => boolean | Promise<boolean>,
): Promise<{ code: number | null; stderr: string; stopped: boolean }> {
  const process = startRg(rgPath, args, signal);
  const lines = createInterface({ input: process.child.stdout, crlfDelay: Infinity });
  let stopped = false;
  process.child.stdin.end();
  try {
    for await (const line of lines) {
      checkAbort(signal);
      if (line.trim() && !await onLine(line)) {
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
    lines.close();
    process.kill();
    await process.done;
  }
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

const runText: RunText = async (rgPath, args, input, signal) => {
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
  if (bytes > 65536) throw new Error("Unexpected smart-case probe output overflow");
  return {
    code: result.code,
    stderr: result.stderr,
    stdout: Buffer.concat(chunks).toString("utf8"),
  };
};

/** Resolve rg's query-level default case flag; inline regex flags still apply normally. */
export async function resolveIgnoreCase(
  rgPath: string,
  patterns: readonly string[],
  literal: boolean,
  explicit: boolean | undefined,
  signal?: AbortSignal,
  run: RunText = runText,
): Promise<boolean> {
  checkAbort(signal);
  if (explicit !== undefined) return explicit;
  if (patterns.length === 0) throw new Error("pattern is required (got an empty array)");

  const sources = patterns.map((pattern) => literal ? escapeRegex(pattern) : pattern);
  const args = [
    ...BASE_RG_ARGS,
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
  ];
  const result = await run(rgPath, args, Buffer.from("a\n"), signal);
  checkAbort(signal);
  if (result.code !== 0 && result.code !== 1) {
    throw new Error(result.stderr.trim() || `ripgrep exited with code ${result.code}`);
  }
  const lines = result.stdout.replace(/\r\n/g, "\n").split("\n");
  if (lines.some((line) => line !== "" && line !== "a")) {
    throw new Error("Unexpected smart-case probe output");
  }
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

export function createLinePredicate(
  rgPath: string,
  patterns: readonly string[],
  modes: SearchModes,
  word: boolean,
  signal?: AbortSignal,
): LinePredicate {
  const args = [
    ...BASE_RG_ARGS,
    "--json",
    "--line-number",
    "--passthru",
    "--text",
    "--encoding=none",
    modes.ignoreCase ? "--ignore-case" : "--case-sensitive",
    ...(modes.literal ? ["--fixed-strings"] : []),
    ...(word ? ["--word-regexp"] : []),
    ...patterns.flatMap((pattern) => ["-e", pattern]),
    "--",
    "-",
  ];
  return async (lines) => {
    checkAbort(signal);
    if (lines.length === 0) return [];
    const records = lines.map((line) => {
      const firstLf = line.indexOf(10);
      if (firstLf >= 0 && firstLf !== line.length - 1) {
        throw new Error("Expected exactly one physical candidate line");
      }
      return firstLf >= 0 ? line : Buffer.concat([line, Buffer.from("\n")]);
    });
    const process = startRg(rgPath, args, signal);
    const output = createInterface({ input: process.child.stdout, crlfDelay: Infinity });
    const matches: boolean[] = [];
    try {
      process.child.stdin.end(Buffer.concat(records));
      for await (const line of output) {
        checkAbort(signal);
        const event = JSON.parse(line);
        if (event.type !== "match" && event.type !== "context") continue;
        if (event.data.line_number !== matches.length + 1) {
          throw new Error("rg predicate line-number protocol mismatch");
        }
        matches.push(event.type === "match");
      }
      const result = await process.done;
      checkAbort(signal);
      if (result.error || (result.code !== 0 && result.code !== 1)) {
        throw result.error ?? new Error(result.stderr.trim() || `ripgrep exited with code ${result.code}`);
      }
      if (matches.length !== lines.length) throw new Error("rg predicate ended before all responses");
      return matches;
    } finally {
      output.close();
      process.kill();
      await process.done;
    }
  };
}
