/** Measure the bounded file scan used by read and grep, including UTF-8 validation. */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { scanTextFile } from "../src/pi/text-stream.ts";

const WARMUP_SCANS = 3;
const fixtures = [
  { bytes: 4 * 1024, iterations: 100 },
  { bytes: 64 * 1024, iterations: 100 },
  { bytes: 8 * 1024 * 1024, iterations: 20 },
];
const row = "中文🙂\n";
const directory = await mkdtemp(join(tmpdir(), "hashline-scan-bench-"));
try {
  for (const { bytes, iterations } of fixtures) {
    const path = join(directory, String(bytes));
    const source = row.repeat(Math.ceil(bytes / Buffer.byteLength(row)));
    await writeFile(path, source);
    for (let i = 0; i < WARMUP_SCANS; i++) await scanTextFile(path);
    const start = performance.now();
    for (let i = 0; i < iterations; i++) await scanTextFile(path);
    console.log(
      JSON.stringify({
        bytes: Buffer.byteLength(source),
        iterations,
        msPerScan: (performance.now() - start) / iterations,
      }),
    );
  }
} finally {
  await rm(directory, { recursive: true, force: true });
}
