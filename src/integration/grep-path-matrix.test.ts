import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { DEFAULT_GREP_FLAGS, searchText } from "../core/search.ts";
import { DEFAULT_CONFIG } from "../pi/config.ts";
import { makeGrepOverrideWithBackend } from "../pi/grep-tool.ts";
import { reportOf } from "../pi/report.ts";
import { runRgPaths } from "../pi/rg-process.ts";
import { callTool } from "../pi/tool-call.testing.ts";
import { acceptsNative } from "../core/search-matrix.testing.ts";
import { rejectsArgument } from "../pi/argument-error.testing.ts";

test("Cartesian literal mode × flags × case override × line mode × bytes → the real grep path agrees with JS", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "hl-grep-path-matrix-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const source = "a.b\naxb\n[ab]\na|b\n-e\n\\K\nK\na\nb\na�b\n😀\nk\nK\nK\ns\nS\nſ\n";
  const inputs = [
    { name: "lf.txt", bytes: Buffer.from(source) },
    { name: "crlf.txt", bytes: Buffer.from(source.replaceAll("\n", "\r\n")) },
    {
      name: "malformed.txt",
      bytes: Buffer.concat([Buffer.from([0x61, 0xff, 0x62, 0x0d, 0x0a]), Buffer.from(source)]),
    },
  ];
  for (const input of inputs) await writeFile(join(directory, input.name), input.bytes);
  const limit = inputs.reduce((sum, input) => sum + input.bytes.length, 0);
  const candidates = new Set<string>();
  const tool = makeGrepOverrideWithBackend(directory, DEFAULT_CONFIG, {
    runRgPaths(rg, args, signal, onPath) {
      return runRgPaths(rg, args, signal, (path) => {
        candidates.add(basename(path));
        return onPath(path);
      });
    },
  });
  let calls = 0;
  let rejected = 0;
  let nativeMatchingFiles = 0;
  let extraCandidates = 0;
  const flagsCases = [undefined, "", "i", "iu", "iv", "ims", "my"];
  const patterns = ["a.b", "\\K", "a\nb", "a�b", "😀", "\uD83D", "k", "s", "[ab]", "a|b", "-e"];
  for (const pattern of patterns) {
    for (const literal of [false, true]) {
      for (const flags of flagsCases) {
        for (const ignoreCase of [false, true]) {
          for (const multiline of [false, true]) {
            const params = {
              pattern,
              literal,
              flags,
              ignoreCase,
              multiline,
              outputMode: "count",
              limit,
            };
            const resolvedFlags =
              (flags ?? DEFAULT_GREP_FLAGS).replace("i", "") + (ignoreCase ? "i" : "");
            const query = { patterns: [pattern], literal, flags: resolvedFlags, multiline };
            const context = JSON.stringify(params);
            candidates.clear();
            if (!literal && !acceptsNative(query)) {
              await assert.rejects(callTool(tool, params), rejectsArgument("pattern"), context);
              assert.equal(candidates.size, 0, context);
              rejected++;
              continue;
            }
            const expected = inputs
              .map((input) => ({
                name: input.name,
                matches: searchText({ source: input.bytes.toString("utf8"), query, limit }).lines
                  .length,
              }))
              .filter((input) => input.matches > 0);
            const actual = await callTool(tool, params);
            calls++;
            assert.equal(
              actual.isError,
              undefined,
              `${context}: ${JSON.stringify(reportOf(actual))}`,
            );
            assert.equal(
              reportOf(actual)?.matches,
              expected.reduce((sum, input) => sum + input.matches, 0),
              context,
            );
            assert.equal(reportOf(actual)?.files, expected.length, context);
            for (const input of expected) {
              nativeMatchingFiles++;
              assert.ok(candidates.has(input.name), `${context}: rg dropped ${input.name}`);
            }
            extraCandidates += [...candidates].filter(
              (name) => !expected.some((input) => input.name === name),
            ).length;
            if (expected.length) {
              const body = actual.content[0];
              assert.ok(body.type === "text");
              assert.deepEqual(
                body.text.split("\n").sort(),
                expected.map((input) => `${input.name}: ${input.matches}`).sort(),
                context,
              );
            }
          }
        }
      }
    }
  }
  t.diagnostic(
    JSON.stringify({
      calls,
      rejected,
      byteInputs: inputs.length,
      nativeMatchingFiles,
      extraCandidates,
    }),
  );
  assert.ok(nativeMatchingFiles > 0);
});
