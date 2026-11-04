import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { Readable } from "node:stream";
import { searchDiagnostic, runRgLines } from "./rg-process.ts";
import { fileURLToPath } from "node:url";
import { HashlineError } from "../core/errors.ts";

test("grep search exit status → accepts no matches and preserves failure diagnostics", () => {
  for (const [code, stopped, stderr, expected] of [
    [0, false, "", undefined],
    [1, false, "", undefined],
    [2, false, " \n", "ripgrep exited with code 2."],
    [null, false, "", "ripgrep exited with code null."],
    [null, true, "", undefined],
    [2, false, "  regex parse error\n", "regex parse error"],
    [null, true, "  regex parse error\n", "regex parse error"],
  ] as const) {
    assert.equal(
      searchDiagnostic({ code, stderr, stopped }),
      expected,
      JSON.stringify({ code, stderr, stopped }),
    );
  }
});

const listingFixture = fileURLToPath(
  new URL("../testing/rg-line-listing.fixture.mjs", import.meta.url),
);
const parserTimeoutMs = 5_000;

async function parseListing(
  t: TestContext,
  chunks: readonly string[],
  maxLines = 10,
  stop = false,
  splitChunks?: readonly Buffer[],
) {
  const spawn = childProcess.spawn;
  const mock = t.mock.method(childProcess, "spawn", (...args: Parameters<typeof spawn>) => {
    const child = spawn(process.execPath, args[1] ?? [], args[2]);
    if (splitChunks) {
      assert.ok(child.stdout);
      const stream = Readable.from(splitChunks);
      t.mock.method(child.stdout, Symbol.asyncIterator, () => stream[Symbol.asyncIterator]());
    }
    return child;
  });
  syncBuiltinESMExports();
  try {
    const files: { path: string; lines: readonly number[] | undefined }[] = [];
    const result = await runRgLines(
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
  } finally {
    mock.mock.restore();
    syncBuiltinESMExports();
  }
}

test("line listing split at every byte → newline paths, empty rows, and grouped files survive", async (t) => {
  const listing = Buffer.from(
    "dir\n文件.txt\0" + "1:\n2:x\n10:[Omitted long matching line]\n\n" + "other.txt\0" + "3:y\n\n",
  );
  for (let split = 1; split < listing.length; split++) {
    const { files, result } = await parseListing(t, [], 10, false, [
      listing.subarray(0, split),
      listing.subarray(split),
    ]);
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
});

test("line listing exceeds maxLines → only the overflowing file requests all-line review", async (t) => {
  for (const maxLines of [2, 3]) {
    const { files } = await parseListing(
      t,
      ["many\0" + "1:x\n2:y\n3:z\n\nfew\0" + "1:\n\n"],
      maxLines,
    );
    assert.deepEqual(files, [
      { path: "many", lines: maxLines === 2 ? undefined : [1, 2, 3] },
      { path: "few", lines: [1] },
    ]);
  }
});

test("line consumer returns false → process stops before the next file", async (t) => {
  const { files, result } = await parseListing(
    t,
    ["first\0" + "1:x\n\nsecond\0" + "2:y\n\n"],
    10,
    true,
  );
  assert.deepEqual(files, [{ path: "first", lines: [1] }]);
  assert.equal(result.stopped, true);
});

test("line listing ends with incomplete path or row → RIPGREP_FAILED", async (t) => {
  for (const record of ["unfinished-path", "file\0" + "1:x", "file\0" + "1"]) {
    await assert.rejects(
      parseListing(t, [record]),
      (error: unknown) => error instanceof HashlineError && error.errorCode === "RIPGREP_FAILED",
    );
  }
});

test("line listing ends after a complete row → flush the final file without a separator", async (t) => {
  const { files, result } = await parseListing(t, ["final\0" + "1:x\n"]);
  assert.deepEqual(files, [{ path: "final", lines: [1] }]);
  assert.equal(result.code, 0);
});
