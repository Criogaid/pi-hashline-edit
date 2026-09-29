/** Run with node --expose-gc bench/grep-memory.bench.ts to measure sparse-match file retention. */
import { mkdtemp, open, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { makeGrepOverrideWithBackend } from "../src/pi/grep-tool.ts";

const directory = await mkdtemp(join(tmpdir(), "hashline-grep-memory-"));
const files = 24;
const mibPerFile = 8;
let timer: ReturnType<typeof setInterval> | undefined;
try {
  const block = Buffer.from(("x".repeat(1023) + "\n").repeat(1024));
  for (let index = 0; index < files; index++) {
    const handle = await open(join(directory, `file-${index}.txt`), "w");
    try {
      await handle.writeFile("needle\n");
      for (let chunk = 0; chunk < mibPerFile; chunk++) await handle.writeFile(block);
    } finally {
      await handle.close();
    }
  }
  globalThis.gc?.();
  const initial = process.memoryUsage();
  let heap = initial.heapUsed;
  let rss = initial.rss;
  const sample = () => {
    const usage = process.memoryUsage();
    heap = Math.max(heap, usage.heapUsed);
    rss = Math.max(rss, usage.rss);
  };
  timer = setInterval(sample, 5);
  const start = performance.now();
  const result = await makeGrepOverrideWithBackend(directory, {}).execute(
    "bench",
    { path: directory, pattern: "needle", literal: true },
    undefined,
    undefined,
  );
  sample();
  const text = result.content[0];
  if (text.type !== "text" || (text.text.match(/ · 1 match\n/g) ?? []).length !== files)
    throw new Error("Missing benchmark matches");
  console.log(
    JSON.stringify(
      {
        files,
        sourceMiB: files * mibPerFile,
        durationMs: Math.round(performance.now() - start),
        initialHeapMiB: +(initial.heapUsed / 2 ** 20).toFixed(1),
        peakHeapMiB: +(heap / 2 ** 20).toFixed(1),
        initialRssMiB: +(initial.rss / 2 ** 20).toFixed(1),
        peakRssMiB: +(rss / 2 ** 20).toFixed(1),
      },
      null,
      2,
    ),
  );
} finally {
  if (timer) clearInterval(timer);
  await rm(directory, { recursive: true, force: true });
}
