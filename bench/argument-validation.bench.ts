/** Measure prepareArguments plus Pi's mandatory validation, without executing tools. */
import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { validateToolArguments, type Tool, type ToolCall } from "@earendil-works/pi-ai";
import { compile } from "@earendil-works/pi-schema";
import { formats } from "@earendil-works/pi-schema/formats";
import { outputBudgetsFor } from "../src/pi/budgets.ts";
import { loadConfig } from "../src/pi/config.ts";
import { makeEditOverride } from "../src/pi/edit-tool.ts";
import { runAlone } from "../src/pi/mutation-runner.ts";
import { makeReadOverride } from "../src/pi/read-tool.ts";
import { makeWriteOverride } from "../src/pi/write-tool.ts";

const iterations = 250;
const samples = 5;
const warmupIterations = 100;
const writeBytes = 1024 * 1024;
const editOperations = 20;
const cwd = process.cwd();
const env = {
  cwd,
  config: { ...loadConfig(cwd), actionFusion: false },
  budgets: () => outputBudgetsFor(undefined),
  schedule: runAlone,
};
const edit = makeEditOverride(env);
const write = makeWriteOverride(env);
const editArgs = {
  path: "file.txt",
  steps: Array.from({ length: editOperations }, (_, index) => ({
    action: "delete",
    anchor: `${index + 1}#${"A".repeat(env.config.hashLen)}`,
  })),
};
const writeArgs = { path: "file.txt", content: "x".repeat(writeBytes), mode: "create" };
const scenarios: readonly {
  readonly label: string;
  readonly tool: Tool & { prepareArguments?(args: unknown): unknown };
  readonly args: ToolCall["arguments"];
  readonly rejected?: true;
}[] = [
  { label: "read", tool: makeReadOverride(env), args: { path: "file.txt" } },
  { label: `edit (${editOperations} ops)`, tool: edit, args: editArgs },
  { label: `write (${writeBytes} bytes)`, tool: write, args: writeArgs },
  {
    label: `edit semantic reject (${editOperations} ops)`,
    tool: edit,
    args: { ...editArgs, steps: [...editArgs.steps.slice(1), { action: "delete" }] },
    rejected: true,
  },
  {
    label: `write schema reject (${writeBytes} bytes)`,
    tool: write,
    args: { ...writeArgs, mode: "invalid" },
    rejected: true,
  },
];
for (const { label, tool, args, rejected } of scenarios) {
  const run = () => {
    let prepared: unknown;
    try {
      prepared = tool.prepareArguments ? tool.prepareArguments(args) : args;
    } catch (error) {
      if (!rejected || !(error instanceof Error)) throw error;
      assert.match(error.message, /"error": "INVALID_ARGUMENTS"/);
      return;
    }
    assert.ok(!rejected, `${label} should be rejected in prepareArguments`);
    validateToolArguments(tool, {
      type: "toolCall",
      id: "benchmark",
      name: tool.name,
      arguments: prepared as ToolCall["arguments"],
    });
  };
  for (let index = 0; index < warmupIterations; index++) run();
  const times = Array.from({ length: samples }, () => {
    const start = performance.now();
    for (let index = 0; index < iterations; index++) run();
    return (performance.now() - start) / iterations;
  }).sort((a, b) => a - b);
  console.log(`${label}: ${times.map((time) => time.toFixed(4)).join(", ")} ms/call (sorted)`);
}

// Probe the installed parse() against one column that saturates the local diagnostics.
const invalidSteps = Array.from({ length: 30 }, () => ({ action: "unknown" }));
const validator = compile(edit.parameters, { formats, coerce: true, unresolvedRefs: "reject" });
const parsed = validator.parse({ path: "", steps: invalidSteps });
assert.equal(parsed.ok, false);
assert.ok(!("value" in parsed));
const action = parsed.errors.find(({ path }) => path === "/steps/0/action");
assert.equal(action?.keyword, "const");
assert.ok(parsed.errors.some(({ path }) => path === "/path"));
console.log(
  `parse probe: ${parsed.errors.length} raw errors, ${action.keyword} at ${action.path} (${action.message}), no prepared value`,
);
