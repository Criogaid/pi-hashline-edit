import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, open, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeReadOverride } from "../pi/read-tool.ts";
import { makeEditOverride } from "../pi/edit-tool.ts";
import { byteRevision } from "../pi/file-commit.ts";
import { makeGrepOverrideWithBackend } from "../pi/grep-tool.ts";
import { computeLineHash } from "../core/hash.ts";
import { callTool } from "../pi/tool-call.testing.ts";
import { DEFAULT_CONFIG } from "../pi/config.ts";

const call = (tool: any, params: any) => callTool(tool, params, { toolCallId: "large-text" });

test("read and line-based grep retain anchors on LF and CRLF files over 100 MiB", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hashline-large-text-"));
  try {
    const read = makeReadOverride(directory, DEFAULT_CONFIG);
    const grep = makeGrepOverrideWithBackend(directory, DEFAULT_CONFIG, {});
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
      assert.ok(first.content[0].text.includes(`1#${computeLineHash(1, "needle", 4)}│needle`));
      const last: any = await call(read, { path, offset: 103426, limit: 1 });
      assert.ok(last.content[0].text.includes(`103426#${computeLineHash(103426, "tail", 4)}│tail`));
      const result: any = await call(grep, { path, pattern: "needle", literal: true });
      assert.ok(result.content[0].text.includes(`1#${computeLineHash(1, "needle", 4)}│needle`));
      assert.doesNotMatch(result.content[0].text, /Search incomplete/);
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
    const grep = makeGrepOverrideWithBackend(directory, DEFAULT_CONFIG, {});
    const result: any = await call(grep, {
      path,
      pattern: ["needle", "standalone\r"],
      literal: true,
    });
    assert.ok(result.content[0].text.includes(`2#${computeLineHash(2, "needle", 4)}│needle`));
    assert.ok(result.content[0].text.includes(`3#${computeLineHash(3, "standalone\r", 4)}│`));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("copy/move a 150,000-line block → publish every captured line", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "hashline-large-transfer-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "transfer.txt");
  const lineCount = 150_000;
  const block = "  value🙂\r\n".repeat(lineCount);
  const source = `\uFEFFSTART\n${block}END`;
  const read = makeReadOverride(directory, DEFAULT_CONFIG);
  const edit = makeEditOverride(directory, DEFAULT_CONFIG);
  const observedAnchor = async (line: number) => {
    const result: Awaited<ReturnType<typeof read.execute>> = await callTool(read, {
      path,
      offset: line,
      limit: 1,
    });
    const rows = result.content
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join("\n");
    const match = new RegExp(`^(${line}#[0-9A-Z]+)│`, "m").exec(rows);
    assert(match);
    return match[1];
  };
  for (const op of ["copy", "move"] as const) {
    await writeFile(path, source);
    const [anchor, end, after] = await Promise.all([
      observedAnchor(2),
      observedAnchor(lineCount + 1),
      observedAnchor(lineCount + 2),
    ]);
    const result: Awaited<ReturnType<typeof edit.execute>> = await callTool(edit, {
      path,
      edits: [{ op, anchor, end, after }],
    });
    const expected = Buffer.from(
      (op === "copy" ? source : "\uFEFFSTART\nEND") + "\r\n" + block.slice(0, -2),
      "utf8",
    );
    assert.deepEqual(await readFile(path), expected);
    assert.equal(result.details.publishedRevision, byteRevision(expected));
    assert.equal(result.details.publication, "PUBLISHED");
  }
});
