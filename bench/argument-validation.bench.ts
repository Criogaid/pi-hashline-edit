/** Measure prepareArguments plus Pi's mandatory validation, without executing tools. */
import { performance } from "node:perf_hooks";
import { validateToolArguments, type Tool, type ToolCall } from "@earendil-works/pi-ai";
import { DEFAULT_CONFIG } from "../src/pi/config.ts";
import { makeEditOverride } from "../src/pi/edit-tool.ts";
import { makeReadOverride } from "../src/pi/read-tool.ts";
import { makeWriteOverride } from "../src/pi/write-tool.ts";

const iterations = 1_000;
const warmupIterations = 100;
const writeBytes = 1024 * 1024;
const editOperations = 20;
const cwd = process.cwd();
const scenarios: readonly {
  readonly label: string;
  readonly tool: Tool & { prepareArguments?(args: unknown): unknown };
  readonly args: ToolCall["arguments"];
}[] = [
  { label: "read", tool: makeReadOverride(cwd, DEFAULT_CONFIG), args: { path: "file.txt" } },
  {
    label: `edit (${editOperations} ops)`,
    tool: makeEditOverride(cwd, DEFAULT_CONFIG),
    args: {
      path: "file.txt",
      edits: Array.from({ length: editOperations }, () => ({ op: "append", body: ["new line"] })),
    },
  },
  {
    label: `write (${writeBytes} bytes)`,
    tool: makeWriteOverride(cwd),
    args: { path: "file.txt", content: "x".repeat(writeBytes) },
  },
];
for (const { label, tool, args } of scenarios) {
  const run = () => {
    const prepared = tool.prepareArguments ? tool.prepareArguments(args) : args;
    validateToolArguments(tool, {
      type: "toolCall",
      id: "benchmark",
      name: tool.name,
      arguments: prepared as ToolCall["arguments"],
    });
  };
  for (let index = 0; index < warmupIterations; index++) run();
  const start = performance.now();
  for (let index = 0; index < iterations; index++) run();
  console.log(`${label}: ${((performance.now() - start) / iterations).toFixed(3)} ms/call`);
}
