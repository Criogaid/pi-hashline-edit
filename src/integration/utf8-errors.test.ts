import assert from "node:assert/strict";
import { constants, isUtf8 } from "node:buffer";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DEFAULT_CONFIG } from "../pi/config.ts";
import { makeEditOverride } from "../pi/edit-tool.ts";
import { makeReplaceTool } from "../pi/replace-tool.ts";
import { byteRevision } from "../pi/file-revision.ts";
import { callTool } from "../pi/tool-call.testing.ts";
import { expectToolFailure } from "../pi/report-failure.testing.ts";

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
          : { path, replacements: [{ literal: true, find: "中文", replace: "汉字" }] };
      await expectToolFailure(callTool(tool, args), "FILESYSTEM_ERROR", (report) => {
        assert.doesNotMatch(JSON.stringify(report), /UNSUPPORTED_ENCODING/);
        assert.match(report.message ?? "", /ERR_STRING_TOO_LONG/);
        assert.equal(report.cause, undefined);
        assert.equal(report.publication, "NOT_PUBLISHED");
      });
      assert.equal(byteRevision(await readFile(path)), originalRevision);
    });
  }
});
