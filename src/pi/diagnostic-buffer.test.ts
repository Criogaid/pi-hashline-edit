import assert from "node:assert/strict";
import { test } from "node:test";
import { DiagnosticBuffer } from "./diagnostic-buffer.ts";
import { MAX_SEARCH_DIAGNOSTIC_BYTES } from "./budgets.ts";
import { formatSearchWarnings } from "./grep-output.ts";
import { MAX_RG_STDERR_BYTES, runText } from "./rg-process.ts";

const diagnostic = (size: number) =>
  `regex parse error:\n${"intermediate context 中🙂\n".repeat(size)}error: unclosed group\n`;

test("bounded diagnostics retain opening context and the final cause across streamed chunks", () => {
  const source = diagnostic(MAX_SEARCH_DIAGNOSTIC_BYTES);
  const buffer = new DiagnosticBuffer(MAX_SEARCH_DIAGNOSTIC_BYTES);
  const chunkChars = 113;
  for (let offset = 0; offset < source.length; offset += chunkChars) {
    buffer.append(source.slice(offset, offset + chunkChars));
  }
  const result = buffer.toString();
  assert.match(result, /^regex parse error:/);
  assert.match(result, /error: unclosed group\n$/);
  assert.match(result, /omitted/i);
  assert.ok(Buffer.byteLength(result) <= MAX_SEARCH_DIAGNOSTIC_BYTES);
});

test("diagnostics within the budget are unchanged", () => {
  const buffer = new DiagnosticBuffer(MAX_SEARCH_DIAGNOSTIC_BYTES);
  const source = "path: 权限不足🙂\nretry with another path\n";
  for (const point of source) buffer.append(point);
  assert.equal(buffer.toString(), source);
});

test("search warning aggregation retains the final cause and labels truncation", () => {
  const result = formatSearchWarnings([diagnostic(MAX_SEARCH_DIAGNOSTIC_BYTES)]);
  assert.match(result, /Search incomplete/);
  assert.match(result, /regex parse error:/);
  assert.match(result, /error: unclosed group/);
  assert.match(result, /omitted/i);
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
