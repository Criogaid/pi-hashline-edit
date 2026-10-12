import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { rgPath } from "@vscode/ripgrep";
import { acceptsNative } from "../core/search-matrix.testing.ts";
import { searchText, type GrepQuery } from "../core/search.ts";
import { searchFiles, type GrepMatch } from "../pi/grep-search.ts";
import { lineCandidatePatterns } from "../pi/rg-regex.ts";
import { runRgLines } from "../pi/rg-process.ts";

// Ordered pairs expose decoder and boundary interactions between the required byte fragments.
const pieces = [
  ...[
    "a",
    "b",
    "A",
    "1",
    "_",
    " ",
    "\r",
    "\u2028",
    "\u2029",
    "😀",
    "𐐀",
    "𐐨",
    "�",
    "ſ",
    "k",
    "K",
    "K",
    "ß",
    "ı",
    "Σ",
    "σ",
    "ς",
    "\u0558",
  ].map((text) => Buffer.from(text)),
  ...[[0x80], [0xc3], [0xe2, 0x82], [0xed, 0xa0, 0x80], [0xf0, 0x9f, 0x98], [0xff]].map((bytes) =>
    Buffer.from(bytes),
  ),
];
const patterns = [
  "\\uD83D",
  "\\uDE00",
  "[\\uD800-\\uDFFF]",
  "😀",
  "𐐀",
  "\\uFFFD",
  "a\\uFFFDb",
  "k",
  "s",
  "[ks]",
  "Σ",
  "ß",
  "ı",
  "\\w",
  "\\W",
  ".",
  "[^a]",
  "[\\p{ASCII}&&\\p{Letter}]",
  "[\\p{Letter}--[a]]",
  "[\\q{ab|😀}]",
  "[[a-c]&&[b-d]]",
  "[[a-c]--[b]]",
  "[\\p{Letter}&&[a-c]]",
  "[[a-c]--\\p{Uppercase_Letter}]",
  "[a[bc]\\q{de|fg}]",
  "[\\q{ab|cd}&&\\q{cd|ef}]",
  "[\\q{ab|cd}--\\q{cd}]",
  "[\\q{ab|}]",
  "[[a]--[a]]",
  "[[^a]&&[ab]]",
  "[[ab]--[^a]]",
  "[^[a]--[b]]",
  "[\\q{\\uFFFD|a\\uFFFDb|😀|\\r|\\u2028}]",
  "[\\q{ab|a}]+",
  "[[Kkſs]--[k]]",
  "(?i:[\\q{ks|ab}])",
  "(?-i:[[aA]--[A]])",
  "([[a]--[A]])\\1",
  "([[a]--[A]])(?i:\\1)",
  "((?-i:[[a]--[A]]))(?i:\\1)",
  "((?-i:[\\q{a|b}]))(?i:\\1)",
  "((?-i:a))(?i:\\1)",
  "(?i:([\\q{ks|ab}]))\\1",
  "[\\q{\\u0558|a}&&\\p{Letter}]",
  "[[\\u0100-\\u0300]&&[ſı]]",
  "[[\\u0100-\\u0300]--[ſ]]",
  `[\\q{${"a".repeat(300)}|b}]`,
  "(?m:^)",
  "(?m:$)",
  "(?-m:^)",
  "(?-m:$)",
  "(?i:k)",
  "(a)\\1",
  "(a)?\\1",
  "(a)|\\1",
  "(^a)\\1",
  "(?i:(k))\\1",
  "(k)(?i:\\1)",
  "(?:(?<n>a)|(?<n>b))\\k<n>",
  "(\\w)\\1{4}",
  "[A-Z]{10,}",
  "a$",
  "$\\d{0,2}\\b",
  "(?=a)",
  "(?!a)",
  "(?<=a)",
  "(?<!a)",
  "^",
  "$",
  "\\b",
  "\\B",
  "^a",
  "a^",
  "$a",
  "\\ba",
  "a\\b",
  "\\Ba",
  "a\\B",
  "(?m:^)b",
  "(?m:b$)",
];
const processTimeoutMs = 10_000;
const matrixTimeoutMs = 180_000;
const candidateLineLimit = 65_536;

const sortedRows = (rows: readonly GrepMatch[]) =>
  [...rows].sort((a, b) => a.filePath.localeCompare(b.filePath) || a.lineNumber - b.lineNumber);

test("Cartesian adversarial bytes × syntax × flags × assertion positions → rg rows contain JS and final rows equal JS", {
  timeout: matrixTimeoutMs,
}, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "hl-grep-line-candidates-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const corpus = (separator: string) => {
    const chunks = [Buffer.from("\nab\naa\naab\nkk\nkK\nKk\nb\r\naaaaa\nABCDEFGHIJ\n")];
    for (const left of pieces)
      for (const right of pieces) chunks.push(left, right, Buffer.from(separator));
    return Buffer.concat(chunks);
  };
  const inputs = [
    { filePath: join(directory, "lf.txt"), bytes: corpus("\n") },
    { filePath: join(directory, "crlf.txt"), bytes: corpus("\r\n") },
    {
      filePath: join(directory, "tail.txt"),
      bytes: Buffer.from("miss\na\rb\nx\u2028b\n😀\n𐐀\na�b\nb\r"),
    },
  ];
  for (const input of inputs) await writeFile(input.filePath, input.bytes);
  const limit = inputs.reduce((sum, input) => sum + input.bytes.length, 0);
  let checked = 0;
  let invalid = 0;
  let listedRows = 0;
  let nativeRows = 0;
  for (const atom of patterns) {
    for (const flags of ["", "m", "iu", "v", "iv", "mv"]) {
      // Wrapping places each assertion inside a consuming sequence as well as at its edges.
      for (const queryPatterns of [[atom], [`a(?:${atom})b`], [atom, "Z"]]) {
        const query: GrepQuery = {
          patterns: queryPatterns,
          flags,
          literal: false,
          multiline: false,
        };
        if (!acceptsNative(query)) {
          invalid++;
          continue;
        }
        const translated = lineCandidatePatterns(query);
        assert.ok(translated, JSON.stringify(query));
        const candidates = new Map<string, readonly number[] | undefined>();
        const warnings: string[] = [];
        const actual = await searchFiles({
          backend: {
            async runRgPaths() {
              assert.fail(`unexpected file fallback: ${JSON.stringify(query)}`);
            },
            runRgLines: (rg, args, signal, maxLines, onFile) => {
              assert.equal(maxLines, candidateLineLimit);
              const emitted = args.flatMap((arg, index) => (arg === "-e" ? [args[index + 1]] : []));
              assert.deepEqual(emitted, translated);
              return runRgLines(rg, args, signal, maxLines, (path, lines) => {
                candidates.set(path, lines);
                listedRows += lines?.length ?? 0;
                return onFile(path, lines);
              });
            },
          },
          rgPath,
          scope: { globs: [], noIgnore: false, follow: false, searchPaths: [directory] },
          query,
          limit,
          timeoutMs: processTimeoutMs,
          signal: AbortSignal.timeout(processTimeoutMs),
          warnings,
        });
        const expected = inputs.flatMap(({ filePath, bytes }) => {
          const result = searchText({ source: bytes.toString("utf8"), query, limit });
          for (const row of result.lines) {
            const context = JSON.stringify({ query, filePath, row });
            assert.ok(candidates.has(filePath), context);
            const lines = candidates.get(filePath);
            assert.ok(lines !== undefined && lines.includes(row.lineNumber), context);
          }
          return result.lines.map((row) => ({ ...row, filePath }));
        });
        assert.deepEqual(warnings, [], JSON.stringify(query));
        assert.deepEqual(sortedRows(actual.raw), sortedRows(expected), JSON.stringify(query));
        assert.equal(actual.matchLimitReached, false);
        nativeRows += expected.length;
        checked++;
      }
    }
  }
  assert.ok(checked > 0 && nativeRows > 0);
  t.diagnostic(
    JSON.stringify({ checked, invalid, byteInputs: inputs.length, listedRows, nativeRows }),
  );
});
