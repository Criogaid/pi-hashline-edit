import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { rgPath } from "@vscode/ripgrep";
import { searchText, type GrepQuery } from "../core/search.ts";
import { searchFiles, type GrepFileMatch } from "../pi/grep-search.ts";
import { runRgLines, runRgPaths } from "../pi/rg-process.ts";
import { runCandidatePaths } from "../pi/grep-candidates.ts";
import { lineCandidatePatterns } from "../pi/rg-regex.ts";
import { extractPrefilter } from "../core/search-analysis.ts";
import { REGEX_TRANSLATION_CORPUS } from "../testing/regex-translation-corpus.ts";

const timeoutMs = 10_000;
const sorted = (files: readonly Pick<GrepFileMatch, "filePath" | "rows">[]) =>
  files
    .flatMap(({ filePath, rows }) => rows.map((row) => ({ ...row, filePath })))
    .sort((a, b) => a.filePath.localeCompare(b.filePath) || a.lineNumber - b.lineNumber);

test("upstream regex witnesses × LF/CRLF/malformed bytes → sound candidates, intended selectivity and exact JS results", {
  timeout: 120_000,
}, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "hl-regex-upstream-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  for (const [index, example] of REGEX_TRANSLATION_CORPUS.entries()) {
    await t.test(`${example.pattern.slice(0, 90)} /${example.flags}`, async () => {
      const query: GrepQuery = {
        patterns: [example.pattern],
        flags: example.flags,
        literal: false,
        multiline: false,
      };
      for (const value of example.hits)
        assert.ok(
          searchText({ source: value, query, limit: 100 }).lines.length,
          `${example.source}: ${JSON.stringify(value)}`,
        );
      for (const value of example.misses)
        assert.equal(
          searchText({ source: value, query, limit: 100 }).lines.length,
          0,
          `${example.source}: ${JSON.stringify(value)}`,
        );
      const inputs = [];
      for (const [name, separator] of [
        ["lf", "\n"],
        ["crlf", "\r\n"],
      ]) {
        const source = [
          ...example.hits,
          ...example.misses,
          "a\rb",
          "\u0558",
          "éÉΣςKſ𐐀𐐨😀",
          "Σ",
          "a�b",
          "",
        ].join(separator);
        const bytes = Buffer.concat([
          Buffer.from(source),
          Buffer.from([0x80, 0xc3, 0xe2, 0x82, 0xed, 0xa0, 0x80, 0xf0, 0x9f, 0x98, 0xff]),
          Buffer.from(`${separator}tail\r`),
        ]);
        const filePath = join(directory, `${index}-${name}.txt`);
        await writeFile(filePath, bytes);
        inputs.push({ bytes, filePath });
      }
      const candidates = new Map<string, readonly number[] | undefined>();
      const warnings: string[] = [];
      const result = await searchFiles({
        backend: {
          runRgPaths: async () => assert.fail("unexpected file fallback"),
          runRgLines: (rg, args, signal, maxLines, onFile) =>
            runRgLines(rg, args, signal, maxLines, (path, lines) => {
              candidates.set(resolve(path), lines);
              return onFile(path, lines);
            }),
        },
        rgPath,
        scope: {
          globs: [],
          noIgnore: false,
          follow: false,
          searchPaths: inputs.map((input) => input.filePath),
        },
        query,
        limit: 1000,
        timeoutMs,
        signal: AbortSignal.timeout(timeoutMs),
        warnings,
      });
      const expected = inputs.map(({ bytes, filePath }) => {
        const native = searchText({ source: bytes.toString("utf8"), query, limit: 1000 });
        for (const row of native.lines)
          assert.ok(
            candidates.get(filePath)?.includes(row.lineNumber),
            `missing candidate ${filePath}:${row.lineNumber}`,
          );
        if (example.rejectCandidates)
          for (let offset = 0; offset < example.misses.length; offset++) {
            const line = example.hits.length + offset + 1;
            assert.equal(
              candidates.get(filePath)?.includes(line) ?? false,
              false,
              `unfiltered ${JSON.stringify(example.misses[offset])}`,
            );
          }
        return { filePath, rows: native.lines };
      });
      assert.deepEqual(warnings, []);
      assert.deepEqual(sorted(result.files), sorted(expected));
    });
  }
});

test("real rg AND/OR file prefilter → excludes incomplete branches before JS verification", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "hl-regex-conjunction-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const fixtures = ["foo\nbar", "baz\nqux", "foo\nqux", "baz\nbar", "foo", "bar", "unrelated"];
  const paths: string[] = [];
  for (const [index, source] of fixtures.entries()) {
    const path = join(directory, `${index}.txt`);
    await writeFile(path, source);
    paths.push(path);
  }
  const query: GrepQuery = {
    patterns: ["(?:foo.*bar|baz.*qux)"],
    flags: "s",
    literal: false,
    multiline: true,
  };
  const candidates: string[] = [];
  const listing = await runCandidatePaths(
    runRgPaths,
    rgPath,
    extractPrefilter(query),
    ["--", directory],
    AbortSignal.timeout(timeoutMs),
    (path) => {
      candidates.push(resolve(path));
      return true;
    },
  );
  assert.equal(listing.code, 0);
  assert.equal(listing.stderr, "");
  assert.deepEqual(candidates.sort(), paths.slice(0, 2).sort());
  const warnings: string[] = [];
  const result = await searchFiles({
    backend: { runRgPaths, runRgLines },
    rgPath,
    scope: { globs: [], noIgnore: false, follow: false, searchPaths: [directory] },
    query,
    limit: 100,
    timeoutMs,
    warnings,
  });
  assert.deepEqual(warnings, []);
  assert.deepEqual(
    sorted(result.files),
    sorted(
      fixtures.map((source, index) => ({
        filePath: paths[index],
        rows: searchText({ source, query, limit: 100 }).lines,
      })),
    ),
  );
});

test("oversized line translation → file prefilter fallback preserves JS results", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "hl-regex-budget-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const pattern = "a".repeat(30_000);
  const query: GrepQuery = { patterns: [pattern], flags: "", literal: true, multiline: false };
  assert.equal(lineCandidatePatterns(query), undefined);
  const path = join(directory, "long.txt");
  await writeFile(path, pattern);
  let filePasses = 0;
  const warnings: string[] = [];
  const result = await searchFiles({
    backend: {
      runRgPaths: (...args) => {
        filePasses++;
        return runRgPaths(...args);
      },
      runRgLines: async () => assert.fail("translation budget must select file prefilter"),
    },
    rgPath,
    scope: { globs: [], noIgnore: false, follow: false, searchPaths: [path] },
    query,
    limit: 10,
    timeoutMs,
    warnings,
  });
  assert.ok(filePasses > 0);
  assert.deepEqual(warnings, []);
  assert.deepEqual(
    sorted(result.files),
    sorted([{ filePath: path, rows: searchText({ source: pattern, query, limit: 10 }).lines }]),
  );
});
