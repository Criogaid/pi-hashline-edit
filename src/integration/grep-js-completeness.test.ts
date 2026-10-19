import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DEFAULT_CONFIG } from "../pi/config.ts";
import { MAX_MULTILINE_SEARCH_BYTES } from "../pi/grep-search.ts";
import { makeGrepOverrideWithBackend } from "../pi/grep-tool.ts";
import { reportOf } from "../pi/report.ts";
import { grepCounts } from "../pi/grep-output.testing.ts";
import { COMMON_RG_ARGS, runRgLines, runRgPaths } from "../pi/rg-process.ts";
import { searchText } from "../core/search.ts";
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
  assert.equal(result.isError, undefined, JSON.stringify(reportOf(result, "grep")));
  assert.equal(grepCounts(result).files, 3);
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
  assert.equal(grepCounts(explicit).matches, 1);
});

test("JS grep: physical rows, context, and limits agree across output modes", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "hl-grep-js-output-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "input.txt");
  await writeFile(path, "head\r\n😀\r\nab\ntail\n");
  const tool = makeGrepOverrideWithBackend(directory, DEFAULT_CONFIG, {});
  for (const outputMode of ["content", "files", "count"] as const) {
    const result = await callTool(tool, { ...query, path, outputMode, limit: 1, context: 1 });
    assert.equal(result.isError, undefined, JSON.stringify(reportOf(result, "grep")));
    assert.equal(grepCounts(result).matches, 1);
    assert.equal(grepCounts(result).files, 1);
    assert.equal(reportOf(result, "grep")?.matchLimit, 1);
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

test("JS grep: malformed UTF-8 matches the preview text without editable anchors", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "hl-grep-js-preview-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "invalid.txt");
  await writeFile(path, Buffer.from([0x61, 0xff, 0x62, 0x0a]));
  const tool = makeGrepOverrideWithBackend(directory, DEFAULT_CONFIG, {});
  const result = await callTool(tool, { path, pattern: "a.b", literal: false });
  assert.equal(result.isError, undefined, JSON.stringify(reportOf(result, "grep")));
  assert.equal(grepCounts(result).matches, 1);
  assert.equal(reportOf(result, "grep")?.invalidUtf8?.length, 1);
  const body = result.content[0];
  assert.ok(body.type === "text");
  assert.match(body.text, /1│a�b/);
  assert.doesNotMatch(body.text, /\d+#[0-9A-Z]+/);
});

test("oversized line or multiline input → explicit incomplete-search diagnostics", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "hl-grep-js-bound-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "large.txt");
  const good = join(directory, "good.txt");
  await writeFile(path, Buffer.alloc(MAX_MULTILINE_SEARCH_BYTES + 1, 0x61));
  await writeFile(good, "a\n");
  const tool = makeGrepOverrideWithBackend(directory, DEFAULT_CONFIG, {});
  for (const multiline of [false, true]) {
    for (const includeGood of [false, true]) {
      const result = await callTool(tool, {
        path: includeGood ? [path, good] : path,
        pattern: "a",
        literal: true,
        multiline,
      });
      assert.match(reportOf(result, "grep")?.diagnostics ?? "", /large\.txt/);
      if (includeGood) {
        assert.equal(result.isError, undefined);
        assert.equal(grepCounts(result).matches, 1);
        assert.equal(result.details?.incomplete, true);
      } else {
        assert.equal(result.isError, true);
        assert.equal(reportOf(result, "grep")?.error, "SEARCH_INCOMPLETE");
      }
    }
  }
});

test("real rg candidates → include every JS row and preserve confirmed output in both paths", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "hl-grep-prefilter-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const fixtures = [
    ["color.txt", Buffer.from("COLOR\r\ncolour\r\ncolouur\n")],
    ["invalid.txt", Buffer.from([0x61, 0xff, 0x62, 0x0d, 0x0a])],
    ["unicode.txt", Buffer.from("K\nk\nſ\ns\n😀\n")],
    ["span.txt", Buffer.from("alpha\r\nbeta\n")],
    ["miss.txt", Buffer.from("unrelated\n")],
  ] as const;
  for (const [name, bytes] of fixtures) await writeFile(join(directory, name), bytes);
  for (const [pattern, flags, multiline, matches] of [
    ["colou?r", "mi", false, 2],
    ["a\\uFFFDb", "m", false, 1],
    ["k", "miu", false, 2],
    ["alpha\\nbeta", "m", true, 2],
  ] as const) {
    await t.test(`${pattern} /${flags} → identical confirmed results`, async () => {
      const candidates = new Map<string, readonly number[] | undefined>();
      const filtered = makeGrepOverrideWithBackend(directory, DEFAULT_CONFIG, {
        runRgPaths(rg, args, signal, onPath) {
          return runRgPaths(rg, args, signal, (path) => {
            candidates.set(path, undefined);
            return onPath(path);
          });
        },
        runRgLines(rg, args, signal, maxLines, onFile) {
          return runRgLines(rg, args, signal, maxLines, (path, lines) => {
            candidates.set(path, lines);
            return onFile(path, lines);
          });
        },
      });
      const full = makeGrepOverrideWithBackend(directory, DEFAULT_CONFIG, {
        runRgPaths(rg, args, signal, onPath) {
          const scopeStart = args.indexOf("--null");
          assert.ok(scopeStart >= 0);
          return runRgPaths(
            rg,
            [...COMMON_RG_ARGS, "--files", ...args.slice(scopeStart)],
            signal,
            onPath,
          );
        },
        runRgLines(rg, args, signal, _maxLines, onFile) {
          const scopeStart = args.indexOf("--hidden");
          assert.ok(scopeStart >= 0);
          return runRgPaths(
            rg,
            [...COMMON_RG_ARGS, "--files", "--null", ...args.slice(scopeStart)],
            signal,
            (path) => onFile(path, undefined),
          );
        },
      });
      for (const outputMode of ["content", "files", "count"] as const) {
        const params = { path: directory, pattern, flags, multiline, literal: false, outputMode };
        const actual = await callTool(filtered, params);
        const expected = await callTool(full, params);
        assert.equal(actual.isError, undefined, JSON.stringify(reportOf(actual, "grep")));
        assert.equal(expected.isError, undefined, JSON.stringify(reportOf(expected, "grep")));
        assert.equal(grepCounts(actual).matches, matches);
        assert.equal(grepCounts(expected).matches, matches);
        const actualText = actual.content[0];
        const expectedText = expected.content[0];
        assert.ok(actualText.type === "text" && expectedText.type === "text");
        assert.deepEqual(actualText.text.split("\n").sort(), expectedText.text.split("\n").sort());
      }
      assert.ok(candidates.size > 0 && candidates.size < fixtures.length);
      for (const [name, bytes] of fixtures) {
        const path = join(directory, name);
        const rows = searchText({
          source: bytes.toString("utf8"),
          query: { patterns: [pattern], literal: false, flags, multiline },
          limit: bytes.length,
        }).lines;
        if (!rows.length) continue;
        assert.ok(candidates.has(path), `rg dropped ${name}`);
        const listed = candidates.get(path);
        for (const row of rows)
          assert.ok(
            listed === undefined || listed.includes(row.lineNumber),
            `${name}:${row.lineNumber}`,
          );
      }
    });
  }
});
