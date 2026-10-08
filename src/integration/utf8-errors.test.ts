import assert from "node:assert/strict";
import { constants, isUtf8 } from "node:buffer";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DEFAULT_CONFIG } from "../pi/config.ts";
import { makeEditOverride } from "../pi/edit-tool.ts";
import { makeReplaceTool } from "../pi/replace-tool.ts";
import { byteRevision } from "../pi/file-commit.ts";
import { callTool } from "../pi/tool-call.testing.ts";

const SIZE_TEST_TIMEOUT_MS = 60_000;

test("valid UTF-8 exceeding the runtime string limit → mutations retain the size failure without publishing", {
  timeout: SIZE_TEST_TIMEOUT_MS,
}, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "hashline-utf8-size-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "large.txt");
  const source = Buffer.alloc(constants.MAX_STRING_LENGTH + Buffer.byteLength("中文"), 97);
  source.write("中文", 0, "utf8");
  assert.equal(isUtf8(source), true);
  const originalRevision = byteRevision(source);
  await writeFile(path, source);
  const tools = [
    makeEditOverride(directory, DEFAULT_CONFIG),
    makeReplaceTool(directory, DEFAULT_CONFIG),
  ];
  for (const tool of tools) {
    await t.test(tool.name, async () => {
      const args =
        tool.name === "edit"
          ? { path, edits: [{ op: "append", body: ["tail"] }] }
          : { path, replacements: [{ find: "中文", replace: "汉字" }] };
      await assert.rejects(callTool(tool, args), (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.doesNotMatch(error.message, /UNSUPPORTED_ENCODING/);
        assert.ok(error.cause instanceof Error && "code" in error.cause);
        assert.equal(error.cause.code, "ERR_STRING_TOO_LONG");
        return true;
      });
      assert.equal(byteRevision(await readFile(path)), originalRevision);
    });
  }
});
