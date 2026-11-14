import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import * as pi from "@earendil-works/pi-coding-agent";
import { callTool } from "./tool-call.testing.ts";
import { loadConfig } from "./config.ts";
import { outputBudgetsFor } from "./budgets.ts";

test("read delegation with anchors set → native read receives only its own parameters", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "hashline-read-delegation-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const builtin = pi.createReadToolDefinition(dir);
  const execute = t.mock.fn(builtin.execute);
  t.mock.module("@earendil-works/pi-coding-agent", {
    namedExports: {
      ...pi,
      createReadToolDefinition: () => ({ ...builtin, execute }),
    },
  });
  const { makeReadOverride } = await import("./read-tool.ts");
  const tool = makeReadOverride({
    cwd: dir,
    config: loadConfig(dir),
    budgets: () => outputBudgetsFor(undefined),
  });
  await writeFile(
    join(dir, "image.gif"),
    Buffer.from("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7", "base64"),
  );
  await writeFile(join(dir, "nul.txt"), "first\0\nsecond\n");
  await mkdir(join(dir, "directory"));
  for (const [path, isError] of [
    ["image.gif", false],
    ["nul.txt", false],
    ["missing.txt", true],
    ["directory", true],
  ] as const) {
    await t.test(path, async () => {
      const before = execute.mock.callCount();
      const params = { path, offset: 1, limit: 1 };
      const result = await callTool(tool, { ...params, anchors: false });
      assert.equal(execute.mock.callCount(), before + 1);
      assert.deepEqual(execute.mock.calls.at(-1)?.arguments[1], params);
      assert.equal(result.isError === true, isError);
      if (!isError) assert.equal(result.details?.nativeRead, true);
    });
  }
});
