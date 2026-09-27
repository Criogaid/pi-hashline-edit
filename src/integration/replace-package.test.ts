import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { Worker } from "node:worker_threads";

// Node cannot load TypeScript workers directly from an installed node_modules package.
test("regex worker starts from an installed-package path", async () => {
  const root = await mkdtemp(join(process.cwd(), "node_modules", "hashline-worker-test-"));
  try {
    const src = join(root, "src");
    await mkdir(join(src, "pi"), { recursive: true });
    await cp(new URL("../core/", import.meta.url), join(src, "core"), { recursive: true });
    for (const name of ["replace-worker.mjs", "replace-worker.ts", "replace-apply.ts"]) {
      await cp(new URL(`../pi/${name}`, import.meta.url), join(src, "pi", name));
    }
    const worker = new Worker(join(src, "pi", "replace-worker.mjs"), {
      workerData: {
        source: "before\n",
        rules: [{ find: "(before)", replace: "$1 after", regex: true }],
      },
    });
    const result = await new Promise<unknown>((resolve, reject) => {
      worker.once("message", resolve);
      worker.once("error", reject);
      worker.once("exit", (code) => reject(new Error(`Worker exited before responding: ${code}`)));
    });
    assert.deepEqual(result, { result: { text: "before after\n", count: 1 } });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
