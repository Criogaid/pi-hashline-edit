import assert from "node:assert/strict";
import { join } from "node:path";
import { Worker } from "node:worker_threads";

const worker = new Worker(join(process.argv[2], "src", "pi", "replace-worker.mjs"), {
  workerData: {
    source: "before\n",
    rules: [{ find: "(before)", replace: "$1 after", regex: true }],
  },
});
try {
  const result = await new Promise<unknown>((resolve, reject) => {
    worker.once("message", resolve);
    worker.once("error", reject);
    worker.once("exit", (code) => reject(new Error(`Worker exited before responding: ${code}`)));
  });
  assert.deepEqual(result, { result: { text: "before after\n", count: 1 } });
} finally {
  await worker.terminate();
}
