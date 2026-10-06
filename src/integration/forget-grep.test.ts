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
  });
}
