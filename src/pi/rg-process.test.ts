import { test } from "node:test";
import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { Readable } from "node:stream";
import { recordSearchDiagnostics, runRgLines } from "./rg-process.ts";
import { fileURLToPath } from "node:url";
import { HashlineError } from "../core/errors.ts";

test("grep search exit status → accepts no matches and preserves failure diagnostics", () => {
  for (const code of [0, 1]) {
    const warnings: string[] = [];
    recordSearchDiagnostics({ code, stderr: "", stopped: false }, warnings);
    assert.deepEqual(warnings, []);
  }
  const warnings: string[] = [];
  recordSearchDiagnostics({ code: 2, stderr: "  regex parse error\n", stopped: false }, warnings);
  recordSearchDiagnostics({ code: null, stderr: "", stopped: false }, warnings);
  assert.equal(warnings.length, 2);
  assert.equal(warnings[0], "regex parse error");
  assert.match(warnings[1], /null/);
});

const listingFixture = fileURLToPath(
  new URL("../testing/rg-line-listing.fixture.mjs", import.meta.url),
);
const parserTimeoutMs = 5_000;

async function parseListing(chunks: readonly string[], maxLines = 10, stop = false) {
  const files: { path: string; lines: readonly number[] | undefined }[] = [];
  const result = await runRgLines(
    process.execPath,
    [
      listingFixture,
      JSON.stringify(chunks.map((chunk) => Buffer.from(chunk).toString("base64"))),
      ...(stop ? ["wait"] : []),
    ],
    AbortSignal.timeout(parserTimeoutMs),
    maxLines,
    (path, lines) => {
      files.push({ path, lines });
      return !stop;
    },
  );
  return { files, result };
}

test("line listing split at every byte → newline paths, empty rows, and grouped files survive", async (t) => {
  const listing = Buffer.from(
    "dir\n文件.txt\0" + "1:\n2:x\n10:[Omitted long matching line]\n\n" + "other.txt\0" + "3:y\n\n",
  );
  const spawn = childProcess.spawn;
  let chunks: Buffer[] = [];
  try {
    t.mock.method(childProcess, "spawn", (...args: Parameters<typeof spawn>) => {
      const child = spawn(...args);
      assert.ok(child.stdout);
      const stream = Readable.from(chunks);
      t.mock.method(child.stdout, Symbol.asyncIterator, () => stream[Symbol.asyncIterator]());
      return child;
    });
    syncBuiltinESMExports();
    for (let split = 1; split < listing.length; split++) {
      chunks = [listing.subarray(0, split), listing.subarray(split)];
      const { files, result } = await parseListing([]);
      assert.deepEqual(
        files,
        [
          { path: "dir\n文件.txt", lines: [1, 2, 10] },
          { path: "other.txt", lines: [3] },
        ],
        `split=${split}`,
      );
      assert.equal(result.code, 0);
      assert.equal(result.stopped, false);
    }
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  }
});

test("line listing exceeds maxLines → only the overflowing file requests all-line review", async () => {
  for (const maxLines of [2, 3]) {
    const { files } = await parseListing(
      ["many\0" + "1:x\n2:y\n3:z\n\nfew\0" + "1:\n\n"],
      maxLines,
    );
    assert.deepEqual(files, [
      { path: "many", lines: maxLines === 2 ? undefined : [1, 2, 3] },
      { path: "few", lines: [1] },
    ]);
  }
});

test("line consumer returns false → process stops before the next file", async () => {
  const { files, result } = await parseListing(
    ["first\0" + "1:x\n\nsecond\0" + "2:y\n\n"],
    10,
    true,
  );
  assert.deepEqual(files, [{ path: "first", lines: [1] }]);
  assert.equal(result.stopped, true);
});

test("line listing ends with incomplete path or row → RIPGREP_FAILED", async () => {
  for (const record of ["unfinished-path", "file\0" + "1:x", "file\0" + "1"]) {
    await assert.rejects(
      parseListing([record]),
      (error: unknown) => error instanceof HashlineError && error.errorCode === "RIPGREP_FAILED",
    );
  }
});

test("line listing ends after a complete row → flush the final file without a separator", async () => {
  const { files, result } = await parseListing(["final\0" + "1:x\n"]);
  assert.deepEqual(files, [{ path: "final", lines: [1] }]);
  assert.equal(result.code, 0);
});
