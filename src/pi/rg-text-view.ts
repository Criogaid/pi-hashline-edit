import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
  // ponytail: bounded snapshots add disk I/O; use a streaming backend if large scans dominate.
  const directory = await mkdtemp(join(tmpdir(), "hashline-grep-"));
  const result: RgRunResult = { code: 1, stderr: "", stopped: false };
  const paths = new Map<string, string>();
  let snapshotBytes = 0;
  const record = (run: RgRunResult) => {
    result.stderr = (result.stderr + run.stderr).slice(0, 65536);
    if (run.code !== 0 && run.code !== 1 && !run.stopped) result.code = run.code;
    else if (run.code === 0 && result.code === 1) result.code = 0;
    result.stopped ||= run.stopped;
  };
  const flush = async () => {
    if (!paths.size) return !result.stopped;
    // Scope filtering belongs to the original paths. Snapshot names have no ignore/glob semantics.
    const searchArgs = [
      ...matcher, "--encoding=none", "--no-ignore", "--hidden", "--", ...paths.keys(),
    ];
    const run = await runRg(rgPath, searchArgs, signal, async (line) => {
      const event = JSON.parse(line);
      if (event.data?.path) {
        const original = paths.get(resolve(rgText(event.data.path)));
        if (!original) throw new Error("ripgrep returned an unexpected snapshot path");
        event.data.path = { text: original };
      }
      return onLine(JSON.stringify(event));
    });
    record(run);
    for (const path of paths.keys()) await rm(path);
    paths.clear();
    snapshotBytes = 0;
    return !result.stopped;
  };
  try {
    const listArgs = [
      ...COMMON_RG_ARGS, ...scope, "--files", "--null", "--", ...args.slice(boundary + 1),
    ];
    const listed = await runRgPaths(rgPath, listArgs, signal, async (path) => {
      signal?.throwIfAborted();
      const original = resolve(path);
      if (original.startsWith(directory + sep)) return true;
      let text: string | Buffer;
      try {
        const bytes = await readFile(original, { signal });
        // Let rg decide whether a NUL file matches; the result reader rejects confirmed binary hits.
        text = bytes.includes(0) ? bytes : normalizeLineEndings(decodeUtf8(bytes));
      } catch (error) {
        signal?.throwIfAborted();
        const message = error instanceof Error ? error.message : String(error);
        record({ code: 2, stopped: false, stderr: `${original}: ${message}\n` });
        return true;
      }
      const snapshot = join(directory, String(paths.size));
      await writeFile(snapshot, text, { signal });
      paths.set(snapshot, original);
      snapshotBytes += Buffer.byteLength(text);
      return (paths.size < 64 && snapshotBytes < 8 * 1024 * 1024) || await flush();
    });
    // A successful listing is not itself a text match.
    record({ ...listed, code: listed.code === 0 ? 1 : listed.code });
    if (!result.stopped) await flush();
    return result;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
};
