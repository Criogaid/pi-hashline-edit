import assert from "node:assert/strict";
import { test } from "node:test";
import { DiagnosticBuffer } from "./diagnostic-buffer.ts";
import { DEFAULT_OUTPUT_BUDGETS } from "./budgets.ts";
import { assembleGrepOutput } from "./grep-output.ts";
import { MAX_RG_STDERR_BYTES, runText } from "./rg-process.ts";

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

test("search warning aggregation retains the final cause and labels truncation", () => {
  const { facts, payload } = assembleGrepOutput({
    formatted: {
      blocks: ["confirmed match"],
      linesTruncated: false,
      invalidUtf8: [],
      matches: 1,
      files: 1,
    },
    warnings: [diagnostic(DEFAULT_OUTPUT_BUDGETS.fieldBytes)],
    outputMode: "content",
    matchLimitReached: false,
    effectiveLimit: 100,
  });
  assert.equal(payload, "confirmed match");
  assert.match(facts.diagnostics ?? "", /regex parse error:/);
  assert.match(facts.diagnostics ?? "", /error: unclosed group/);
  assert.match(facts.diagnostics ?? "", /omitted/i);
});

test("stderr collection preserves UTF-8 and reports overflow without losing the final cause", async () => {
  for (const source of ["权限不足🙂\n", diagnostic(MAX_RG_STDERR_BYTES)]) {
    const result = await runText(
      process.execPath,
      ["--input-type=module", "--eval", "process.stdin.pipe(process.stderr)"],
      Buffer.from(source),
      AbortSignal.timeout(10000),
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
