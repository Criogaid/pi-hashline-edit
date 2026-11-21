/** Run from the candidate with node bench/file-read.bench.ts <baseline-worktree>. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, open, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { testEnvironment } from "../src/testing/process.testing.ts";

const FILE_MIB = 48;
const MIB = 1024 * 1024;
const SAMPLES = 5;
const MAX_OLD_SPACE_MIB = 192;
const SAMPLE_TIMEOUT_MS = 30_000;
const SCAN_ITERATIONS = 3;
const READ_LINE_LIMIT = 2000;
const ROW_BYTES = 128;
const SNAPSHOT_CASES = {
  "snapshot-small": { bytes: 4 * 1024, iterations: 1000 },
  "snapshot-multi": { bytes: 8 * MIB + ROW_BYTES, iterations: 5 },
} as const;
const SCENARIOS = [
  "overwrite-freshness",
  "read-lines",
  "grep-text",
  "snapshot-small",
  "snapshot-multi",
] as const;
type Scenario = (typeof SCENARIOS)[number];
type ReadEditableSnapshot = typeof import("../src/pi/file-read.ts").readEditableSnapshot;

async function sample(root: string, scenario: Scenario) {
  const commitUrl = pathToFileURL(join(root, "src/pi/file-commit.ts")).href;
  const scanUrl = pathToFileURL(join(root, "src/pi/text-stream.ts")).href;
  const commit: typeof import("../src/pi/file-commit.ts") & {
    readEditableSnapshot?: ReadEditableSnapshot;
  } = await import(commitUrl);
  const { commitFile, observeFreshness } = commit;
  const snapshotCase =
    scenario === "snapshot-small" || scenario === "snapshot-multi"
      ? SNAPSHOT_CASES[scenario]
      : undefined;
  const fileBytes = snapshotCase?.bytes ?? FILE_MIB * MIB;
  // The baseline exports its snapshot reader from file-commit.
  const readSnapshot: ReadEditableSnapshot | undefined = snapshotCase
    ? (commit.readEditableSnapshot ??
      (await import(pathToFileURL(join(root, "src/pi/file-read.ts")).href)).readEditableSnapshot)
    : undefined;
  const { scanTextFile, scanTextLines }: typeof import("../src/pi/text-stream.ts") = await import(
    scanUrl
  );

  const directory = await mkdtemp(join(tmpdir(), "hashline-file-read-bench-"));
  const path = join(directory, "source.txt");
  try {
    const row = "const sample = 'fixture data'; // ".padEnd(ROW_BYTES - 1, "x") + "\n";
    const block = row.repeat(MIB / row.length);
    const hash = createHash("sha256");
    const handle = await open(path, "w");
    try {
      for (let offset = 0; offset < fileBytes; offset += MIB) {
        const chunk = block.slice(0, Math.min(MIB, fileBytes - offset));
        await handle.writeFile(chunk);
        hash.update(chunk);
      }
    } finally {
      await handle.close();
    }
    const expectedRevision = hash.digest("hex");
    const signal = new AbortController().signal;
    const totalLines = fileBytes / ROW_BYTES;
    const iterations =
      snapshotCase?.iterations ?? (scenario === "overwrite-freshness" ? 1 : SCAN_ITERATIONS);
    let snapshot: Awaited<ReturnType<ReadEditableSnapshot>> | undefined;
    const cpuStart = process.cpuUsage();
    const start = performance.now();
    if (scenario === "overwrite-freshness") {
      const content = block.repeat(FILE_MIB);
      assert.deepEqual(await commitFile(path, content, { mode: "overwrite" }, signal), {
        publication: "NOT_PUBLISHED",
        publishedRevision: expectedRevision,
        freshness: "unchanged",
      });
      assert.deepEqual(await observeFreshness(path, expectedRevision, true), {
        freshness: "unchanged",
      });
    } else if (readSnapshot) {
      for (let i = 0; i < iterations; i++) snapshot = await readSnapshot(path, signal);
    } else {
      for (let i = 0; i < iterations; i++) {
        let observed = 0;
        const stats: Awaited<ReturnType<typeof scanTextFile>> =
          scenario === "read-lines"
            ? await scanTextLines(
                path,
                (line) => line <= READ_LINE_LIMIT,
                ({ byteLength }) => {
                  observed += byteLength;
                },
                { signal },
              )
            : await scanTextFile(path, {
                signal,
                decoding: "lossy",
                onChunk(text) {
                  let offset = 0;
                  while ((offset = text.indexOf("\n", offset)) !== -1) {
                    observed++;
                    offset++;
                  }
                },
              });
        assert.equal(
          observed,
          scenario === "read-lines" ? READ_LINE_LIMIT * (ROW_BYTES - 1) : totalLines,
        );
        assert.equal(stats.revision, expectedRevision);
        assert.equal(stats.totalLines, totalLines);
        assert.equal(stats.validUtf8, true);
      }
    }
    const wallMs = performance.now() - start;
    const cpu = process.cpuUsage(cpuStart);
    const peakRssMiB = process.resourceUsage().maxRSS / 1024;
    if (snapshotCase) {
      assert.deepEqual(snapshot, {
        text: row.repeat(totalLines),
        baseRevision: expectedRevision,
      });
    }
    console.log(
      JSON.stringify({
        scenario,
        fileBytes,
        peakRssMiB,
        iterations,
        cpuMs: (cpu.user + cpu.system) / (1000 * iterations),
        wallMs: wallMs / iterations,
      }),
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

const [, , arg, root, mode] = process.argv;
if (arg === "--sample") {
  const scenario = SCENARIOS.find((scenario) => scenario === mode);
  assert(root && scenario);
  await sample(root, scenario);
} else {
  assert(arg && !root, "Usage: node bench/file-read.bench.ts <baseline-worktree>");
  const candidate = fileURLToPath(new URL("../", import.meta.url));
  const variants = [
    ["baseline", resolve(arg)],
    ["candidate", candidate],
  ] as const;
  const agentDir = await mkdtemp(join(tmpdir(), "hashline-bench-agent-"));
  try {
    for (const workload of SCENARIOS) {
      for (let i = 0; i < SAMPLES; i++) {
        const order = i % 2 === 0 ? variants : [...variants].reverse();
        for (const [variant, source] of order) {
          const result = spawnSync(
            process.execPath,
            [
              `--max-old-space-size=${MAX_OLD_SPACE_MIB}`,
              fileURLToPath(import.meta.url),
              "--sample",
              source,
              workload,
            ],
            { env: testEnvironment(agentDir), encoding: "utf8", timeout: SAMPLE_TIMEOUT_MS },
          );
          if (result.error) throw result.error;
          assert.equal(result.status, 0, result.stderr || result.signal || "Sample failed");
          console.log(JSON.stringify({ variant, sample: i + 1, ...JSON.parse(result.stdout) }));
        }
      }
    }
  } finally {
    await rm(agentDir, { recursive: true, force: true });
  }
}
