/** Compare the real read tool with a baseline revision: node bench/read-window.bench.ts 6495f2c. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { outputBudgetsFor } from "../src/pi/budgets.ts";
import { loadConfig } from "../src/pi/config.ts";
import * as candidate from "../src/pi/read-tool.ts";
import { callTool } from "../src/pi/tool-call.testing.ts";

const ref = process.argv[2];
assert.ok(ref, "Pass the baseline Git revision");
const toolUrl = new URL("../src/pi/read-tool.ts", import.meta.url);
const source = execFileSync("git", ["show", `${ref}:src/pi/read-tool.ts`], {
  cwd: new URL("../", import.meta.url),
  encoding: "utf8",
});
const baselineSource = source.replace(/(from ")([^"]+)(")/g, (_match, start, specifier, end) => {
  const resolved = specifier.startsWith(".")
    ? new URL(specifier, toolUrl).href
    : import.meta.resolve(specifier);
  return `${start}${resolved}${end}`;
});
const baseline: typeof candidate = await import(
  `data:text/javascript;base64,${Buffer.from(stripTypeScriptTypes(baselineSource)).toString("base64")}`
);

const LOG_LINES = 18_000;
const WARMUPS = 10;
const SAMPLES = 25;
const logRow = `INFO [plugin] loaded workspace; emitted event with metadata ${"中文😄".repeat(28)} status\r\n`;
const log = Buffer.from(logRow.repeat(LOG_LINES));
const sourceFile = await readFile(new URL("../src/pi/grep-output.ts", import.meta.url));
const fixtures = [
  { name: "repository-file", bytes: sourceFile, options: {} },
  { name: "large-log-default", bytes: log, options: {} },
  { name: "large-log-explicit", bytes: log, options: { limit: LOG_LINES, anchors: false } },
];

const cwd = await mkdtemp(join(tmpdir(), "hashline-read-window-"));
try {
  const env = { cwd, config: loadConfig(cwd), budgets: () => outputBudgetsFor(undefined) };
  const tools = [baseline, candidate].map(({ makeReadOverride }) => makeReadOverride(env));
  for (const { name, bytes, options } of fixtures) {
    const path = `${name}.txt`;
    await writeFile(join(cwd, path), bytes);
    const timings: [number[], number[]] = [[], []];
    for (let i = 0; i < WARMUPS + SAMPLES; i++) {
      const run = async (variant: 0 | 1) => {
        const start = performance.now();
        const result = await callTool(
          tools[variant],
          { path, ...options },
          { toolCallId: "bench" },
        );
        if (i >= WARMUPS) timings[variant].push(performance.now() - start);
        return result;
      };
      const first = (i % 2) as 0 | 1;
      const left = await run(first);
      const right = await run(first === 0 ? 1 : 0);
      assert.equal(left.isError, undefined);
      assert.deepEqual(left, right);
    }
    const [old, next] = timings;
    const summarize = (samples: readonly number[]) => {
      const ordered = samples.toSorted((left, right) => left - right);
      return {
        medianMs: Number(ordered[Math.floor(SAMPLES / 2)].toFixed(3)),
        p90Ms: Number(ordered[Math.ceil(SAMPLES * 0.9) - 1].toFixed(3)),
      };
    };
    console.log(
      JSON.stringify({
        name,
        bytes: bytes.length,
        samples: SAMPLES,
        baseline: summarize(old),
        candidate: summarize(next),
        wins: old.filter((ms, i) => next[i] < ms).length,
      }),
    );
  }
} finally {
  await rm(cwd, { recursive: true, force: true });
}
