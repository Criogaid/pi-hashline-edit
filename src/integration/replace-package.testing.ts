import assert from "node:assert/strict";
import { join } from "node:path";
import { Worker } from "node:worker_threads";

for (const { entry, input, expected } of [
  {
    entry: "replace-worker.mjs",
    input: { source: "before\n", rules: [{ find: "(before)", replace: "$1 after", regex: true }] },
    expected: { text: "before after\n", count: 1 },
  },
  {
    entry: "grep-worker.mjs",
    input: {
      source: "😀\r\na\n",
      query: { patterns: ["^..$"], literal: false, multiline: false, flags: "m" },
      limit: 10,
    },
    expected: { lines: [{ lineNumber: 1, column: 0 }], totalLines: 2 },
  },
]) {
  const worker = new Worker(join(process.argv[2], "src", "pi", entry));
  try {
    const result = await new Promise<unknown>((resolve, reject) => {
      worker.once("message", resolve);
      worker.once("error", reject);
      worker.once("exit", (code) => reject(new Error(`Worker exited before responding: ${code}`)));
      worker.postMessage(input);
    });
    assert.deepEqual(result, { result: expected });
  } finally {
    await worker.terminate();
  }
}
