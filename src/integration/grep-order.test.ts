import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { computeLineHash } from "../core/hash.ts";
import { DEFAULT_CONFIG } from "../pi/config.ts";
import { parseFileHeader } from "../pi/grep-output.ts";
import { makeGrepOverrideWithBackend } from "../pi/grep-tool.ts";
import { reportOf } from "../pi/report.ts";
import { callTool } from "../pi/tool-call.testing.ts";

test("repeated real-rg query with increasing limits → identical bytes and a growing path-ordered row prefix", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "hl-grep-order-integration-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await mkdir(join(dir, "sub"));
  const names = ["z.txt", "sub/b.txt", "a.txt"];
  const sourceLine = (name: string, line: number) => `needle ${name} ${line}`;
  for (const name of names) {
    await writeFile(join(dir, name), `${sourceLine(name, 1)}\n${sourceLine(name, 2)}\n`);
  }
  const expected = [...names].sort().flatMap((name) =>
    [1, 2].map((line) => {
      const source = sourceLine(name, line);
      return `${name}\n${line}#${computeLineHash(line, source, DEFAULT_CONFIG.hashLen)}│${source}`;
    }),
  );
  const tool = makeGrepOverrideWithBackend(dir, DEFAULT_CONFIG, {});
  for (const multiline of [false, true]) {
    let previous: string[] = [];
    for (const limit of [1, 3, expected.length]) {
      const query = { path: dir, pattern: "needle", literal: true, multiline, limit };
      const first = await callTool(tool, query);
      const second = await callTool(tool, query);
      for (const result of [first, second]) {
        assert.equal(result.isError, undefined, JSON.stringify(reportOf(result)));
      }
      assert.deepEqual(
        Buffer.from(JSON.stringify(first.content)),
        Buffer.from(JSON.stringify(second.content)),
      );
      const body = first.content[0];
      assert.ok(body.type === "text");
      const rows: string[] = [];
      let path = "";
      for (const line of body.text.split("\n")) {
        const header = parseFileHeader(line);
        if (header) path = header.path;
        else if (/^\d+#[0-9A-Z]+│/.test(line)) rows.push(`${path}\n${line}`);
      }
      assert.deepEqual(rows, expected.slice(0, limit));
      assert.deepEqual(rows.slice(0, previous.length), previous);
      previous = rows;
    }
  }
});
