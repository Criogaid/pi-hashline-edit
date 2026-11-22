/**
 * Time and heap per Action Fusion progress update: the report and Pi's Bash card render.
 * Run `node bench/fusion-progress.bench.ts` on each reporter revision with the same Node binary.
 */
import assert from "node:assert/strict";
import { performance, PerformanceObserver, type PerformanceEntry } from "node:perf_hooks";
import { setImmediate } from "node:timers/promises";
import { serialize } from "node:v8";
import {
  createBashToolDefinition,
  DEFAULT_MAX_BYTES,
  initTheme,
  truncateTail,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { theme } from "../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js";
import { registerFusionCards } from "../src/pi/fusion-card.ts";
import type { ActionFusionProgress } from "../src/pi/report-schema.ts";

const iterations = 4096;
const batchSize = 16;
const warmup = 512;
const line = "test passed".padEnd(79, ".") + "\n";
const cwd = process.cwd();
const render = createBashToolDefinition(cwd).renderResult!;
initTheme("dark", false);
console.log(`${process.version} ${process.platform}/${process.arch} · median / p95`);

async function measure(label: string, update: () => void) {
  for (let i = 0; i < warmup; i++) update();
  const times = new Float64Array(iterations);
  const batches = [];
  for (let i = 0; i < iterations; i++) {
    const start = performance.now();
    update();
    times[i] = (performance.now() - start) * 1000;
  }
  // Heap growth measures allocations only in intervals without collection. Exclude overlapping GCs.
  const collections: PerformanceEntry[] = [];
  const observer = new PerformanceObserver((list) => collections.push(...list.getEntries()));
  observer.observe({ entryTypes: ["gc"] });
  for (let i = 0; i < iterations / batchSize; i++) {
    const start = performance.now();
    const before = process.memoryUsage().heapUsed;
    for (let j = 0; j < batchSize; j++) update();
    const allocated = process.memoryUsage().heapUsed - before;
    batches.push({ start, end: performance.now(), allocated });
  }
  await setImmediate();
  await setImmediate();
  collections.push(...observer.takeRecords());
  observer.disconnect();
  const clean = batches.filter(
    ({ start, end, allocated }) =>
      allocated >= 0 &&
      !collections.some((gc) => gc.startTime <= end && gc.startTime + gc.duration >= start),
  );
  assert.ok(clean.length >= batches.length / 2);
  const bytes = Float64Array.from(clean, ({ allocated }) => allocated / batchSize);
  const summary = (values: Float64Array) => {
    values.sort();
    return [0.5, 0.95].map((q) => values[Math.ceil(values.length * q) - 1].toFixed(2)).join(" / ");
  };
  console.log(`${label}: ${summary(times)} µs/update, ${summary(bytes)} V8 heap B/update`);
}

for (const size of [64, 4096, DEFAULT_MAX_BYTES]) {
  const tail = line.repeat(Math.ceil(size / line.length)).slice(0, size - 1) + ".";
  const truncation = truncateTail(size === DEFAULT_MAX_BYTES ? `discarded\n${tail}` : tail);
  assert.equal(truncation.outputBytes, size);
  const result = {
    content: [{ type: "text" as const, text: truncation.content }],
    details: {
      truncation: truncation.truncated ? truncation : undefined,
      fullOutputPath: truncation.truncated ? "C:/Temp/pi-bash-123456.log" : undefined,
    },
  };
  const progress: ActionFusionProgress = {
    toolCallId: "call-1",
    commandText: "npm test",
    command: "running",
    freshness: "unknown",
    mutationCompleted: true,
    timing: { timeoutSeconds: 60, remainingSeconds: 30 },
    result,
  };
  let endpoints = 0;
  // Registration only installs callbacks. A headless stream calls appendEntry at its endpoints.
  const stub: Partial<ExtensionAPI> = {
    on: () => () => {},
    registerEntryRenderer() {},
    appendEntry() {
      endpoints++;
    },
  };
  const report = registerFusionCards(stub as ExtensionAPI);
  report(progress);
  console.log(
    `${size} output bytes, ${serialize(progress).byteLength} bytes in V8 serialization buffer`,
  );
  await measure("report", () => report(progress));
  assert.equal(endpoints, 1);
  const context: Parameters<typeof render>[3] = {
    args: { command: progress.commandText },
    toolCallId: progress.toolCallId,
    cwd,
    state: { startedAt: undefined, endedAt: undefined, interval: undefined },
    lastComponent: undefined,
    durationMs: undefined,
    executionStarted: true,
    argsComplete: true,
    isPartial: true,
    expanded: false,
    showImages: false,
    isError: false,
    outputPad: 1,
    invalidate() {},
    keyHint: () => "",
    keyText: () => "",
  };
  await measure("Bash renderResult", () => {
    context.lastComponent = render(result, context, theme, context);
  });
}
