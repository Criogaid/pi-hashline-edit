/** Real ripgrep results consumed and forgotten through Pi's session lifecycle. */
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { FORGET_MIN_BYTES } from "../pi/budgets.ts";
import {
  assertForgotten,
  finish,
  forgetCall,
  openForgetSession,
  SESSION_TIMEOUT_MS,
  taggedResultId,
  toolResponse,
  toolResult,
} from "../pi/forget.testing.ts";

for (const encoding of ["UTF-8", "invalid UTF-8"] as const) {
  test(`real grep of ${encoding} logs then forget → matched content is absent from the next request`, {
    timeout: SESSION_TIMEOUT_MS,
  }, async (t) => {
    const f = await openForgetSession(t);
    const path = join(f.cwd, "search.log");
    const rowPayloadChars = 128;
    const rowCount = Math.ceil(FORGET_MIN_BYTES / rowPayloadChars);
    const rows = Array.from(
      { length: rowCount },
      (_, index) => `needle ${index} ${"x".repeat(rowPayloadChars)}`,
    );
    const bytes = Buffer.concat([
      Buffer.from(rows.join("\n")),
      encoding === "invalid UTF-8" ? Buffer.from([0xff]) : Buffer.alloc(0),
      Buffer.from("\n"),
    ]);
    await writeFile(path, bytes);
    await f.prompt(
      toolResponse({
        type: "toolCall",
        id: "search",
        name: "grep",
        arguments: { path, pattern: "needle", literal: true },
      }),
      (messages) => toolResponse(forgetCall(messages, "search")),
      finish,
    );
    const original = toolResult(f.requests[1], "search");
    assert.equal(original.isError, false);
    const text = original.content
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("\n");
    assert.ok(text.includes(rows[0]));
    if (encoding === "invalid UTF-8") assert.ok(text.includes("\uFFFD"));
    const id = taggedResultId(original);
    assert.ok(id);
    const forgotten = toolResult(f.requests[2], "search");
    assertForgotten(forgotten, id);
    const receipt = forgotten.content[0];
    assert.ok(receipt.type === "text" && !receipt.text.includes("needle"));
    assert.ok(receipt.type === "text" && !receipt.text.includes("search.log"));
    const displayReceipt = `grep /needle/ · ${rows.length} matches in 1 file`;
    assert.deepEqual(f.rawResult("forget-call").details, {
      forgotten: [{ id, receipt: displayReceipt }],
    });
    assert.ok(f.renderForgetCard().includes(displayReceipt));
  });
}

test("real grep reaches its limit across files → forget card reports the returned counts", {
  timeout: SESSION_TIMEOUT_MS,
}, async (t) => {
  const f = await openForgetSession(t);
  const rowPayloadChars = 256;
  const rowsPerFile = Math.ceil(FORGET_MIN_BYTES / rowPayloadChars) + 1;
  const limit = rowsPerFile + 1;
  const paths = [join(f.cwd, "one.log"), join(f.cwd, "two.log")];
  const rows = Array.from(
    { length: rowsPerFile },
    (_, index) => `${index % 2 === 0 ? "needle" : "backup"} ${"x".repeat(rowPayloadChars)}`,
  );
  await Promise.all(paths.map((path) => writeFile(path, `${rows.join("\n")}\n`)));
  await f.prompt(
    toolResponse({
      type: "toolCall",
      id: "search",
      name: "grep",
      arguments: { path: paths, pattern: ["needle", "backup"], literal: true, limit },
    }),
    (messages) => toolResponse(forgetCall(messages, "search")),
    finish,
  );
  const id = taggedResultId(toolResult(f.requests[1], "search"));
  assert.ok(id);
  const receipt = `grep /needle | backup/ · ${limit} matches in ${paths.length} files · limit reached`;
  assert.deepEqual(f.rawResult("forget-call").details, { forgotten: [{ id, receipt }] });
  assert.ok(f.renderForgetCard().includes(receipt));
  assertForgotten(toolResult(f.requests[2], "search"), id);
});

for (const outputMode of [undefined, "content", null, "files", "count"] as const) {
  test(`codemode grep outputMode=${String(outputMode)} → only content output can be forgotten`, {
    timeout: SESSION_TIMEOUT_MS,
  }, async (t) => {
    const f = await openForgetSession(t);
    const path = join(f.cwd, "search.log");
    await writeFile(path, `needle ${"x".repeat(FORGET_MIN_BYTES)}\n`);
    const args = { path, pattern: "needle", literal: true, outputMode };
    const eligible = outputMode === undefined || outputMode === null || outputMode === "content";
    await f.prompt(
      toolResponse({
        type: "toolCall",
        id: "script-search",
        name: "codemode",
        arguments: {
          code: `text(await tools.grep(${JSON.stringify(args)})); text("padding".repeat(${FORGET_MIN_BYTES}));`,
        },
      }),
      (messages) => {
        const result = toolResult(messages, "script-search");
        assert.equal(result.isError, false);
        const id = taggedResultId(result);
        if (eligible) {
          assert.ok(id, "Content-mode inspection output needs a parent tag");
          return toolResponse(forgetCall(messages, "script-search"));
        }
        assert.equal(id, undefined, "Summary-only grep must not make a script forgettable");
        return finish;
      },
      ...(eligible ? [finish] : []),
    );
    const original = toolResult(f.requests[1], "script-search");
    const text = original.content
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("\n");
    assert.equal([...text.matchAll(/\[result r[0-9a-f]{5}\]/g)].length, eligible ? 1 : 0);
    if (eligible) {
      const id = taggedResultId(original);
      assert.ok(id);
      assertForgotten(toolResult(f.requests[2], "script-search"), id);
    }
  });
}
