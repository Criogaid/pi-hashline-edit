/** Run with FORCE_COLOR=3 node bench/collapsed-preview.bench.ts bf2a564. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { stripTypeScriptTypes } from "node:module";
import { performance } from "node:perf_hooks";
import { initTheme, ToolExecutionComponent } from "@earendil-works/pi-coding-agent";
import { ProcessTerminal, TuiMainScreen } from "@earendil-works/pi-tui";
import type { CopiedSpan } from "../src/core/copy-span.ts";
import { generateMutationDetails } from "../src/pi/mutation-result.ts";
import * as candidate from "../src/pi/render.ts";

const ref = process.argv[2];
assert.ok(ref, "Pass the baseline Git revision");
// Load only the baseline renderer so both variants use the same Pi, imports, and fixtures.
const renderUrl = new URL("../src/pi/render.ts", import.meta.url);
const source = execFileSync("git", ["show", `${ref}:src/pi/render.ts`], {
  cwd: new URL("../", import.meta.url),
  encoding: "utf8",
});
const baselineSource = source.replace(/(from ")([^"]+)(")/g, (_match, start, specifier, end) => {
  const resolved = specifier.startsWith(".")
    ? new URL(specifier, renderUrl).href
    : import.meta.resolve(specifier);
  return `${start}${resolved}${end}`;
});
const baseline: typeof candidate = await import(
  `data:text/javascript;base64,${Buffer.from(stripTypeScriptTypes(baselineSource)).toString("base64")}`
);

initTheme("dark");
const tui = new TuiMainScreen(new ProcessTerminal());
const args = { path: "fixture.txt" };
const WIDTH = 100;
const WARMUPS = 10;
const SAMPLES = 31;
const LARGE_FILE_LINES = 25_000;
const variants = [baseline, candidate].map(({ diffCardRenderers, formatDiffCounts }) =>
  diffCardRenderers(
    "edit",
    "Editing…",
    (_args, theme, _cwd, counts) =>
      `edit ${theme.fg("accent", args.path)}${counts ? formatDiffCounts(counts, theme) : ""}`,
  ),
);

function fixture(lineCount: number, shouldEdit: (line: number) => boolean) {
  const before = [];
  const after = [];
  const copied: CopiedSpan[] = [];
  let offset = 0;
  for (let i = 0; i < lineCount; i++) {
    const row = `    setting_${i} = "old value";\n`;
    const edited = shouldEdit(i);
    before.push(row);
    after.push(edited ? `    setting_${i} = "new value";\n` : row);
    if (!edited) copied.push({ sourceStart: offset, targetStart: offset, length: row.length });
    offset += row.length;
  }
  return {
    content: [],
    details: generateMutationDetails(before.join(""), after.join(""), copied),
    isError: false,
  };
}

const small = fixture(6, (i) => i === 3);
const dense = fixture(LARGE_FILE_LINES, () => true);
const scattered = fixture(LARGE_FILE_LINES, (i) => i % 160 === 0);

function compare(name: string, result: ReturnType<typeof fixture>, expanded = false) {
  const timings = [[], []] as [number[], number[]];
  let renderedRows = 0;
  function render(index: number, iteration: number) {
    const card = new ToolExecutionComponent(
      "edit",
      name,
      args,
      {},
      variants[index],
      tui,
      process.cwd(),
    );
    card.setExpanded(expanded);
    const start = performance.now();
    card.updateResult(result);
    const output = card.render(WIDTH);
    const elapsed = performance.now() - start;
    if (iteration >= WARMUPS) timings[index].push(elapsed);
    return output;
  }
  for (let i = 0; i < WARMUPS + SAMPLES; i++) {
    const first = render(i % 2, i);
    const second = render(1 - (i % 2), i);
    assert.deepEqual(first, second);
    renderedRows = first.length;
  }
  const wins = timings[0].filter((ms, i) => timings[1][i] < ms).length;
  function summarize(samples: number[]) {
    const ordered = samples.toSorted((a, b) => a - b);
    return {
      medianMs: Number(ordered[Math.floor(SAMPLES / 2)].toFixed(4)),
      p90Ms: Number(ordered[Math.ceil(SAMPLES * 0.9) - 1].toFixed(4)),
    };
  }
  console.log(
    JSON.stringify({
      name,
      diffRows: result.details.diff.split("\n").length,
      renderedRows,
      warmups: WARMUPS,
      samples: SAMPLES,
      baseline: summarize(timings[0]),
      candidate: summarize(timings[1]),
      wins,
    }),
  );
}

compare("small collapsed", small);
compare("scattered collapsed", scattered);
compare("dense collapsed", dense);
compare("dense expanded", dense, true);
