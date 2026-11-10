import assert from "node:assert/strict";
import { test } from "node:test";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { DiagnosticBuffer } from "./diagnostic-buffer.ts";
import { DEFAULT_OUTPUT_BUDGETS } from "./tool-factories.testing.ts";
import { grepOutput } from "./grep-output.ts";
import { createAnchorFormatter } from "./anchor-format.ts";
import { runRgPaths } from "./rg-process.ts";
const MAX_RG_STDERR_BYTES = 64 * 1024;
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const diagnostic = (size: number) =>
  `regex parse error:\n${"intermediate context 中🙂\n".repeat(size)}error: unclosed group\n`;

test("bounded diagnostics retain opening context and the final cause across streamed chunks", () => {
  const source = diagnostic(DEFAULT_OUTPUT_BUDGETS.fieldBytes);
  const buffer = new DiagnosticBuffer(DEFAULT_OUTPUT_BUDGETS.fieldBytes);
  const chunkChars = 113;
  for (let offset = 0; offset < source.length; offset += chunkChars) {
    buffer.append(source.slice(offset, offset + chunkChars));
  }
  const result = buffer.toString();
  assert.match(result, /^regex parse error:/);
  assert.match(result, /error: unclosed group\n$/);
  assert.match(result, /omitted/i);
  assert.ok(Buffer.byteLength(result) <= DEFAULT_OUTPUT_BUDGETS.fieldBytes);
});

test("a diagnostic is one oversized line → retain its opening and final cause without splitting UTF-8", () => {
  const source = `opening cause: ${"中🙂".repeat(DEFAULT_OUTPUT_BUDGETS.fieldBytes)}; final recovery`;
  const buffer = new DiagnosticBuffer(DEFAULT_OUTPUT_BUDGETS.fieldBytes);
  buffer.append(source);
  const result = buffer.toString();
  assert.match(result, /^opening cause:/);
  assert.match(result, /final recovery$/);
  assert.match(result, /omitted/);
  assert.doesNotMatch(result, /�/);
  assert.ok(Buffer.byteLength(result) <= DEFAULT_OUTPUT_BUDGETS.fieldBytes);
});

test("diagnostics within the budget are unchanged", () => {
  const buffer = new DiagnosticBuffer(DEFAULT_OUTPUT_BUDGETS.fieldBytes);
  const source = "path: 权限不足🙂\nretry with another path\n";
  for (const point of source) buffer.append(point);
  assert.equal(buffer.toString(), source);
});

test("search warning aggregation retains the final cause and labels truncation", async () => {
  const { facts, payload } = await grepOutput({
    budget: DEFAULT_OUTPUT_BUDGETS,
    cwd: process.cwd(),
    anchors: createAnchorFormatter(4),
    context: 0,
    search: {
      files: [
        {
          filePath: join(process.cwd(), "confirmed match"),
          rows: [],
          snapshot: { revision: "", validUtf8: true },
        },
      ],
      matchLimitReached: false,
      scanLimitReached: false,
    },
    warnings: [diagnostic(DEFAULT_OUTPUT_BUDGETS.fieldBytes)],
    outputMode: "files",
    effectiveLimit: 100,
    literalPipe: false,
  });
  assert.equal(payload, "confirmed match");
  assert.match(facts.diagnostics ?? "", /regex parse error:/);
  assert.match(facts.diagnostics ?? "", /error: unclosed group/);
  assert.match(facts.diagnostics ?? "", /omitted/i);
});

test("stderr overflow → UTF-8 opening and final cause survive", async (t) => {
  const spawn = childProcess.spawn;
  t.mock.method(childProcess, "spawn", (...args: Parameters<typeof spawn>) =>
    spawn(process.execPath, args[1] ?? [], args[2]),
  );
  syncBuiltinESMExports();
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });
  const directory = await mkdtemp(join(tmpdir(), "hl-rg-stderr-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "stderr.txt");
  for (const source of ["权限不足🙂\n", diagnostic(MAX_RG_STDERR_BYTES)]) {
    await writeFile(path, source);
    const result = await runRgPaths(
      [
        "--input-type=module",
        "--eval",
        "import { createReadStream } from 'node:fs'; createReadStream(process.argv[1]).pipe(process.stderr)",
        path,
      ],
      AbortSignal.timeout(10000),
      () => true,
    );
    if (Buffer.byteLength(source) <= MAX_RG_STDERR_BYTES) {
      assert.equal(result.stderr, source);
    } else {
      assert.match(result.stderr, /^regex parse error:/);
      assert.match(result.stderr, /error: unclosed group\n$/);
      assert.match(result.stderr, /omitted/i);
      assert.doesNotMatch(result.stderr, /�/);
      assert.ok(Buffer.byteLength(result.stderr) <= MAX_RG_STDERR_BYTES);
    }
  }
});
