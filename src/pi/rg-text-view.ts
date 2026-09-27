import { mkdtemp, open, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { normalizeLineEndings } from "../core/lines.ts";
import { scanTextFile } from "./text-stream.ts";
import { COMMON_RG_ARGS, rgText, runRg, runRgPaths, type RgRunResult } from "./rg-line-filter.ts";

async function writeLfSnapshot(source: string, destination: string, signal?: AbortSignal) {
  const handle = await open(destination, "w");
  let pendingCr = "";
  try {
    const stats = await scanTextFile(
      source,
      async (chunk) => {
        const text = pendingCr + chunk;
        pendingCr = text.endsWith("\r") ? "\r" : "";
        await handle.writeFile(normalizeLineEndings(pendingCr ? text.slice(0, -1) : text));
      },
      signal,
    );
    if (stats.hasNul) throw new Error("File changed during search; rerun the query.");
    if (pendingCr) await handle.writeFile(pendingCr);
  } finally {
    await handle.close();
  }
}

/** Search LF views in batches while reporting original paths and logical match offsets. */
export const runRgTextView: typeof runRg = async (rgPath, args, signal, onLine) => {
  let boundary = args.length;
  const scope: string[] = [];
  const matcher: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--") {
      boundary = i;
      break;
    }
    if (arg === "--glob") scope.push(arg, args[++i]);
    else if (["--hidden", "--no-ignore", "--follow"].includes(arg)) scope.push(arg);
    else {
      matcher.push(arg);
      if (arg === "-e") matcher.push(args[++i]);
    }
  }
  if (boundary === args.length || args[boundary + 1] === "-")
    return runRg(rgPath, args, signal, onLine);
  let directory: string | undefined;
  const result: RgRunResult = { code: 1, stderr: "", stopped: false };
  // LF-only files pass through to rg directly; only CRLF files need temp snapshots.
  const snapshots = new Map<string, string>();
  const searchPaths: string[] = [];
  let batchBytes = 0;
  const record = (run: RgRunResult) => {
    result.stderr = (result.stderr + run.stderr).slice(0, 65536);
    if (run.code !== 0 && run.code !== 1 && !run.stopped) result.code = run.code;
    else if (run.code === 0 && result.code === 1) result.code = 0;
    result.stopped ||= run.stopped;
  };

  const searchBatch = async (
    searchPaths: readonly string[],
    rewritePaths: ReadonlyMap<string, string>,
  ) => {
    const searchArgs = [
      ...matcher,
      "--encoding=none",
      "--no-ignore",
      "--hidden",
      "--",
      ...searchPaths,
    ];
    const run = await runRg(rgPath, searchArgs, signal, async (line) => {
      const event = JSON.parse(line);
      if (event.data?.path) {
        const reported = resolve(rgText(event.data.path));
        const original = rewritePaths.get(reported);
        if (original) event.data.path = { text: original };
        // Passthrough paths need no rewrite — reported path is already the original.
      }
      return onLine(JSON.stringify(event));
    });
    record(run);
  };

  const flush = async () => {
    if (!searchPaths.length) return !result.stopped;
    // Scope filtering belongs to the original paths. Snapshot names have no ignore/glob semantics.
    await searchBatch(searchPaths, snapshots);
    for (const path of snapshots.keys()) await rm(path);
    snapshots.clear();
    searchPaths.length = 0;
    batchBytes = 0;
    return !result.stopped;
  };

  const ensureDirectory = async () => {
    directory ??= await mkdtemp(join(tmpdir(), "hashline-grep-"));
    return directory;
  };

  try {
    const listArgs = [
      ...COMMON_RG_ARGS,
      ...scope,
      "--files",
      "--null",
      "--",
      ...args.slice(boundary + 1),
    ];
    const listed = await runRgPaths(rgPath, listArgs, signal, async (path) => {
      signal?.throwIfAborted();
      const original = resolve(path);
      if (directory && original.startsWith(directory + sep)) return true;
      try {
        const info = await scanTextFile(original, undefined, signal);
        if (info.hasCrLf && !info.hasNul) {
          const dir = await ensureDirectory();
          const snapshot = join(dir, String(snapshots.size));
          await writeLfSnapshot(original, snapshot, signal);
          snapshots.set(snapshot, original);
          searchPaths.push(snapshot);
        } else {
          // Binary files retain their raw bytes; confirmed content hits are rejected later.
          searchPaths.push(original);
        }
        batchBytes += info.byteLength;
      } catch (error) {
        signal?.throwIfAborted();
        const message = error instanceof Error ? error.message : String(error);
        record({ code: 2, stopped: false, stderr: `${original}: ${message}\n` });
        return true;
      }
      return (searchPaths.length < 64 && batchBytes < 8 * 1024 * 1024) || (await flush());
    });
    // A successful listing is not itself a text match.
    record({ ...listed, code: listed.code === 0 ? 1 : listed.code });
    if (!result.stopped) await flush();
    return result;
  } finally {
    if (directory) await rm(directory, { recursive: true, force: true });
  }
};
