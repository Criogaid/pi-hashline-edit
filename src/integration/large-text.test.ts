import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, open, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeReadOverride } from "../pi/read-tool.ts";
import { makeGrepOverrideWithBackend } from "../pi/grep-tool.ts";
import { computeLineHash } from "../core/hash.ts";
import { callTool } from "../pi/tool-call.testing.ts";

const call = (tool: any, params: any) => callTool(tool, params, { toolCallId: "large-text" });

test("read and line-based grep retain anchors on LF and CRLF files over 100 MiB", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hashline-large-text-"));
  try {
    const read = makeReadOverride(directory);
    const grep = makeGrepOverrideWithBackend(directory, {});
    for (const ending of ["\n", "\r\n"]) {
      const path = join(directory, "large.txt");
      const handle = await open(path, "w");
      const line = "x".repeat(1024 - ending.length) + ending;
      const block = Buffer.from(line.repeat(1024));
      try {
        await handle.writeFile("needle" + ending);
        for (let i = 0; i < 101; i++) await handle.writeFile(block);
        await handle.writeFile("tail" + ending);
      } finally {
        await handle.close();
      }
      const first: any = await call(read, { path, limit: 1 });
      assert.match(first.content[0].text, /103426 lines/);
      assert.ok(first.content[0].text.includes(`1#${computeLineHash(1, "needle")}│needle`));
      const last: any = await call(read, { path, offset: 103426, limit: 1 });
      assert.ok(last.content[0].text.includes(`103426#${computeLineHash(103426, "tail")}│tail`));
      for (const modes of [{}, { literal: true }]) {
        const result: any = await call(grep, { path, pattern: "needle", ...modes });
        assert.ok(result.content[0].text.includes(`1#${computeLineHash(1, "needle")}│needle`));
        assert.doesNotMatch(result.content[0].text, /Search incomplete/);
      }
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("CRLF snapshots normalize terminators split across read chunks and preserve standalone CR", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hashline-snapshot-boundary-"));
  try {
    const path = join(directory, "boundary.txt");
    await writeFile(path, "x".repeat(65535) + "\r\nneedle\r\nstandalone\r");
    const grep = makeGrepOverrideWithBackend(directory, {});
    const result: any = await call(grep, {
      path,
      pattern: ["needle", "standalone\r"],
      literal: true,
    });
    assert.ok(result.content[0].text.includes(`2#${computeLineHash(2, "needle")}│needle`));
    assert.ok(result.content[0].text.includes(`3#${computeLineHash(3, "standalone\r")}│`));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
