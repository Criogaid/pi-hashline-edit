import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { normalizeLineEndings } from "../core/lines.ts";
import { decodeUtf8 } from "../core/text.ts";
import { COMMON_RG_ARGS, rgText, runRg, runRgPaths, type RgRunResult } from "./rg-line-filter.ts";

/** Search bounded LF snapshots while reporting original paths and logical match offsets. */
export const runRgTextView: typeof runRg = async (rgPath, args, signal, onLine) => {
  let boundary = args.length;
  const scope: string[] = [];
  const matcher: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--") { boundary = i; break; }
    if (arg === "--glob") scope.push(arg, args[++i]);
    else if (["--hidden", "--no-ignore", "--follow"].includes(arg)) scope.push(arg);
    else {
      matcher.push(arg);
      if (arg === "-e") matcher.push(args[++i]);
    }
  }
  if (boundary === args.length || args[boundary + 1] === "-") return runRg(rgPath, args, signal, onLine);
  let directory: string | undefined;
  const result: RgRunResult = { code: 1, stderr: "", stopped: false };
  // LF-only files pass through to rg directly; only CRLF files need temp snapshots.
  const snapshots = new Map<string, string>();
  const passthroughs: string[] = [];
  let snapshotBytes = 0;
  const record = (run: RgRunResult) => {
    result.stderr = (result.stderr + run.stderr).slice(0, 65536);
    if (run.code !== 0 && run.code !== 1 && !run.stopped) result.code = run.code;
    else if (run.code === 0 && result.code === 1) result.code = 0;
    result.stopped ||= run.stopped;
  };

  const searchBatch = async (searchPaths: readonly string[], rewritePaths: ReadonlyMap<string, string>) => {
    const searchArgs = [
      ...matcher, "--encoding=none", "--no-ignore", "--hidden", "--", ...searchPaths,
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
    if (!snapshots.size && !passthroughs.length) return !result.stopped;
    // Scope filtering belongs to the original paths. Snapshot names have no ignore/glob semantics.
    const allPaths = [...snapshots.keys(), ...passthroughs];
    await searchBatch(allPaths, snapshots);
    for (const path of snapshots.keys()) await rm(path);
    snapshots.clear();
    passthroughs.length = 0;
    snapshotBytes = 0;
    return !result.stopped;
  };

  const ensureDirectory = async () => {
    directory ??= await mkdtemp(join(tmpdir(), "hashline-grep-"));
    return directory;
  };

  try {
    const listArgs = [
      ...COMMON_RG_ARGS, ...scope, "--files", "--null", "--", ...args.slice(boundary + 1),
    ];
    const listed = await runRgPaths(rgPath, listArgs, signal, async (path) => {
      signal?.throwIfAborted();
      const original = resolve(path);
      if (directory && original.startsWith(directory + sep)) return true;
      try {
        const info = await stat(original);
        if (info.size > 100 * 1024 * 1024) {
          record({ code: 2, stopped: false, stderr: `${original}: file exceeds 100 MiB; skipped\n` });
          return true;
        }
        const bytes = await readFile(original, { signal });
        if (bytes.includes(0)) {
          // Binary/NUL: let rg decide via snapshot, the result reader rejects confirmed binary hits.
          const dir = await ensureDirectory();
          const snapshot = join(dir, String(snapshots.size));
          await writeFile(snapshot, bytes, { signal });
          snapshots.set(snapshot, original);
          snapshotBytes += bytes.length;
        } else {
          const decoded = decodeUtf8(bytes);
          if (!decoded.includes("\r\n")) {
            // Pure LF (or no line endings at all): search the original file directly.
            passthroughs.push(original);
            snapshotBytes += bytes.length;
          } else {
            const dir = await ensureDirectory();
            const snapshot = join(dir, String(snapshots.size));
            await writeFile(snapshot, normalizeLineEndings(decoded), { signal });
            snapshots.set(snapshot, original);
            snapshotBytes += bytes.length;
          }
        }
      } catch (error) {
        signal?.throwIfAborted();
        const message = error instanceof Error ? error.message : String(error);
        record({ code: 2, stopped: false, stderr: `${original}: ${message}\n` });
        return true;
      }
      const batchSize = snapshots.size + passthroughs.length;
      return (batchSize < 64 && snapshotBytes < 8 * 1024 * 1024) || await flush();
    });
    // A successful listing is not itself a text match.
    record({ ...listed, code: listed.code === 0 ? 1 : listed.code });
    if (!result.stopped) await flush();
    return result;
  } finally {
    if (directory) await rm(directory, { recursive: true, force: true });
  }
};
