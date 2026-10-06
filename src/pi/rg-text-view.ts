import { DiagnosticBuffer } from "./diagnostic-buffer.ts";
import { createHash } from "node:crypto";
import { mkdtemp, open, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { normalizeLineEndings } from "../core/lines.ts";
import { scanTextFile } from "./text-stream.ts";
import {
  COMMON_RG_ARGS,
  MAX_RG_STDERR_BYTES,
  rgText,
  runRg,
  runRgPaths,
  type RgRunResult,
} from "./rg-process.ts";
import { scopeArgs, type SearchRunner, type SearchTextView } from "./grep-search.ts";
import { errorMessage } from "../core/errors.ts";
import { searchChangedError, throwIfCancelled } from "./error-text.ts";

/** CRLF snapshot batches flush after this many files or source bytes (README: 64 files / 8 MiB). */
const SNAPSHOT_BATCH_FILES = 64;
const SNAPSHOT_BATCH_BYTES = 8 * 1024 * 1024;
const LF_VIEW = { kind: "lf" } as const;

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
    if (stats.hasNul) throw searchChangedError();
    if (pendingCr) await handle.writeFile(pendingCr);
  } finally {
    await handle.close();
  }
}

/** Search LF views in batches while reporting original paths and logical match offsets. */
export const runRgTextView: SearchRunner = async (
  rgPath,
  { matcher, rawMatcher, scope },
  signal,
  onLine,
) => {
  let directory: string | undefined;
  const result: RgRunResult = { code: 1, stderr: "", stopped: false };
  const diagnostics = new DiagnosticBuffer(MAX_RG_STDERR_BYTES);
  // Only valid UTF-8 CRLF files use LF snapshots; malformed UTF-8 keeps its raw search view.
  const snapshots = new Map<string, string>();
  const views = new Map<string, SearchTextView>();
  const batchPaths: string[] = [];
  let batchBytes = 0;
  const record = (run: RgRunResult) => {
    diagnostics.append(run.stderr);
    result.stderr = diagnostics.toString();
    if (run.code !== 0 && run.code !== 1 && !run.stopped) result.code = run.code;
    else if (run.code === 0 && result.code === 1) result.code = 0;
    result.stopped ||= run.stopped;
  };

  const searchBatch = async (
    batchPaths: readonly string[],
    rewritePaths: ReadonlyMap<string, string>,
    matcher: readonly string[],
  ) => {
    const searchArgs = [
      ...matcher,
      "--encoding=none",
      "--no-ignore",
      "--hidden",
      "--",
      ...batchPaths,
    ];
    const run = await runRg(rgPath, searchArgs, signal, async (line) => {
      const event = JSON.parse(line);
      let view: SearchTextView = LF_VIEW;
      if (event.data?.path) {
        const reported = resolve(rgText(event.data.path));
        view = views.get(reported)!;
        const original = rewritePaths.get(reported);
        if (original) event.data.path = { text: original };
        // Passthrough paths need no rewrite — reported path is already the original.
      }
      return onLine(JSON.stringify(event), view);
    });
    record(run);
  };

  const flush = async () => {
    if (!batchPaths.length) return !result.stopped;
    // Scope filtering belongs to the original paths. Snapshot names have no ignore/glob semantics.
    if (rawMatcher) {
      const groups = new Map<SearchTextView["kind"], string[]>();
      for (const path of batchPaths) {
        const view = views.get(path)!.kind;
        const paths = groups.get(view) ?? [];
        paths.push(path);
        groups.set(view, paths);
      }
      for (const [view, paths] of groups) {
        await searchBatch(paths, snapshots, view === "raw" ? rawMatcher : matcher);
        if (result.stopped) break;
      }
    } else {
      await searchBatch(batchPaths, snapshots, matcher);
    }
    for (const path of snapshots.keys()) await rm(path);
    snapshots.clear();
    views.clear();
    batchPaths.length = 0;
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
      ...scopeArgs(scope),
      "--files",
      "--null",
      "--",
      ...scope.searchPaths,
    ];
    const listed = await runRgPaths(rgPath, listArgs, signal, async (path) => {
      throwIfCancelled(signal);
      const original = resolve(path);
      if (directory && original.startsWith(directory + sep)) return true;
      try {
        const hash = createHash("sha256");
        const info = await scanTextFile(
          original,
          undefined,
          signal,
          (bytes) => hash.update(bytes),
          "lossy",
        );
        if (info.hasNul) return true;
        if (info.hasCrLf && info.validUtf8) {
          const dir = await ensureDirectory();
          const snapshot = join(dir, String(snapshots.size));
          await writeLfSnapshot(original, snapshot, signal);
          snapshots.set(snapshot, original);
          views.set(snapshot, LF_VIEW);
          batchPaths.push(snapshot);
        } else {
          views.set(
            original,
            info.validUtf8
              ? LF_VIEW
              : {
                  kind: "raw",
                  snapshot: {
                    revision: hash.digest("hex"),
                    validUtf8: false,
                    totalLines: info.totalLines,
                  },
                },
          );
          batchPaths.push(original);
        }
        batchBytes += info.byteLength;
      } catch (error) {
        throwIfCancelled(signal);
        const message = errorMessage(error);
        record({ code: 2, stopped: false, stderr: `${original}: ${message}\n` });
        return true;
      }
      return (
        (batchPaths.length < SNAPSHOT_BATCH_FILES && batchBytes < SNAPSHOT_BATCH_BYTES) ||
        (await flush())
      );
    });
    // A successful listing is not itself a text match.
    record({ ...listed, code: listed.code === 0 ? 1 : listed.code });
    if (!result.stopped) await flush();
    return result;
  } finally {
    if (directory) await rm(directory, { recursive: true, force: true });
  }
};
