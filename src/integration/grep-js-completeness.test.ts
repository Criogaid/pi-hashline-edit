import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Worker } from "node:worker_threads";
import { DEFAULT_CONFIG } from "../pi/config.ts";
import { MAX_JS_SEARCH_FILE_BYTES } from "../pi/grep-javascript.ts";
import { makeGrepOverrideWithBackend } from "../pi/grep-tool.ts";
import { reportOf } from "../pi/report.ts";
import { runRgPaths } from "../pi/rg-process.ts";
import { callTool } from "../pi/tool-call.testing.ts";

const query = { pattern: "^..$", literal: false, ignoreCase: false };

test("JS grep: rg discovery retains ignore, hidden, glob, and binary rules", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "hl-grep-js-scope-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await mkdir(join(directory, "nested"));
  for (const name of [
    "allowed.txt",
    ".hidden.txt",
    "ignored.txt",
    "excluded.txt",
    "nested/child.txt",
  ])
    await writeFile(join(directory, name), "😀\n");
  await writeFile(join(directory, ".ignore"), "ignored.txt\n");
  await writeFile(join(directory, "binary.txt"), "😀\n\0");
  const tool = makeGrepOverrideWithBackend(directory, DEFAULT_CONFIG, {});
  const result = await callTool(tool, {
    ...query,
    path: directory,
    glob: "!excluded.txt",
    outputMode: "files",
  });
  assert.equal(result.isError, undefined, JSON.stringify(reportOf(result)));
  assert.equal(reportOf(result)?.files, 3);
  const body = result.content[0];
  assert.ok(body.type === "text");
  for (const name of ["allowed.txt", ".hidden.txt", "child.txt"])
    assert.ok(body.text.includes(name), name);
  assert.doesNotMatch(body.text, /ignored|excluded|binary/);
  const explicit = await callTool(tool, {
    ...query,
    path: join(directory, "ignored.txt"),
    glob: "*.txt",
  });
  assert.equal(reportOf(explicit)?.matches, 1);
});

test("JS grep: physical rows, context, and limits agree across output modes", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "hl-grep-js-output-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "input.txt");
  await writeFile(path, "head\r\n😀\r\nab\ntail\n");
  const tool = makeGrepOverrideWithBackend(directory, DEFAULT_CONFIG, {});
  for (const outputMode of ["content", "files", "count"] as const) {
    const result = await callTool(tool, { ...query, path, outputMode, limit: 1, context: 1 });
    assert.equal(result.isError, undefined, JSON.stringify(reportOf(result)));
    assert.equal(reportOf(result)?.matches, 1);
    assert.equal(reportOf(result)?.files, 1);
    assert.equal(reportOf(result)?.matchLimit, 1);
    const body = result.content[0];
    assert.ok(body.type === "text");
    if (outputMode === "content") {
      assert.match(body.text, /1#[0-9A-Z]+│head/);
      assert.match(body.text, /2#[0-9A-Z]+│😀/);
      assert.match(body.text, /3#[0-9A-Z]+│ab/);
      assert.doesNotMatch(body.text, /│tail/);
    } else if (outputMode === "count") assert.match(body.text, /input\.txt: 1/);
    else assert.match(body.text, /input\.txt/);
  }
});

test("JS grep: changes beyond a limited multiline result invalidate every output mode", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "hl-grep-js-revision-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "input.txt");
  const tool = makeGrepOverrideWithBackend(directory, DEFAULT_CONFIG, {
    runRgPaths(rg, args, signal, onPath) {
      return runRgPaths(rg, args, signal, async (found) => {
        const keepGoing = await onPath(found);
        await writeFile(path, "😀\nchanged\n");
        return keepGoing;
      });
    },
  });
  for (const outputMode of ["content", "files", "count"] as const) {
    await writeFile(path, "😀\nkeep\n");
    const result = await callTool(tool, {
      path,
      pattern: "(?s:.)+",
      literal: false,
      multiline: true,
      limit: 1,
      outputMode,
    });
    assert.equal(result.isError, true);
    assert.equal(reportOf(result)?.error, "FILE_CHANGED");
  }
});

test("JS grep: malformed UTF-8 matches the preview text without editable anchors", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "hl-grep-js-preview-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "invalid.txt");
  await writeFile(path, Buffer.from([0x61, 0xff, 0x62, 0x0a]));
  const tool = makeGrepOverrideWithBackend(directory, DEFAULT_CONFIG, {});
  const result = await callTool(tool, { path, pattern: "a.b", literal: false });
  assert.equal(result.isError, undefined, JSON.stringify(reportOf(result)));
  assert.equal(reportOf(result)?.matches, 1);
  assert.equal(reportOf(result)?.invalidUtf8?.length, 1);
  const body = result.content[0];
  assert.ok(body.type === "text");
  assert.match(body.text, /1│a�b/);
  assert.doesNotMatch(body.text, /\d+#[0-9A-Z]+/);
});

test("JS grep: catastrophic evaluation can time out or be cancelled", {
  timeout: 15_000,
}, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "hl-grep-js-stop-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "input.txt");
  await writeFile(path, `${"a".repeat(100)}!`);
  const config = { ...DEFAULT_CONFIG, grep: { ...DEFAULT_CONFIG.grep, regexTimeoutMs: 3_000 } };
  const tool = makeGrepOverrideWithBackend(directory, config, {});
  const params = { path, pattern: "(?=.)^(a+)+$", literal: false };
  const timeout = await callTool(tool, params);
  assert.equal(reportOf(timeout)?.error, "REGEX_TIMEOUT");
  assert.equal(reportOf(timeout)?.timeoutMs, config.grep.regexTimeoutMs);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 1_000);
  try {
    const cancelled = await callTool(tool, params, { signal: controller.signal });
    assert.equal(reportOf(cancelled)?.error, "OPERATION_ABORTED");
  } finally {
    clearTimeout(timer);
  }
  const recovered = await callTool(tool, { ...params, pattern: "a." });
  assert.equal(recovered.isError, undefined);
  assert.equal(reportOf(recovered)?.matches, 1);
});

test("JS grep: oversized text is reported as incomplete rather than no matches", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "hl-grep-js-bound-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "large.txt");
  await writeFile(path, Buffer.alloc(MAX_JS_SEARCH_FILE_BYTES + 1, 0x61));
  const tool = makeGrepOverrideWithBackend(directory, DEFAULT_CONFIG, {});
  const result = await callTool(tool, { path, pattern: ".", literal: false });
  assert.equal(result.isError, true);
  assert.equal(reportOf(result)?.error, "SEARCH_INCOMPLETE");
  assert.match(reportOf(result)?.diagnostics ?? "", /large\.txt/);
});

test("JS grep: worker rows must describe the searched snapshot", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "hl-grep-js-reply-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "input.txt");
  await writeFile(path, "😀\n");
  for (const result of [
    { lines: [{ lineNumber: 2, column: 0 }], totalLines: 1 },
    {
      lines: [
        { lineNumber: 1, column: 0 },
        { lineNumber: 1, column: 0 },
      ],
      totalLines: 1,
    },
    { lines: [{ lineNumber: 1, column: 0 }], totalLines: 2 },
    { lines: [{ lineNumber: 1, column: -1 }], totalLines: 1 },
    { lines: [{ lineNumber: 1, column: 999 }], totalLines: 1 },
  ]) {
    await t.test(JSON.stringify(result), async (t) => {
      const emit = Worker.prototype.emit;
      t.mock.method(
        Worker.prototype,
        "emit",
        function (this: Worker, event: string | symbol, ...args: unknown[]) {
          return emit.call(this, event, ...(event === "message" ? [{ result }] : args));
        },
      );
      const tool = makeGrepOverrideWithBackend(directory, DEFAULT_CONFIG, {});
      const failure = await callTool(tool, { ...query, path });
      assert.equal(failure.isError, true);
      assert.equal(reportOf(failure)?.error, "REGEX_WORKER_FAILED");
    });
  }
});
