import { test } from "node:test";
import assert from "node:assert/strict";
import { Type } from "typebox";
import { parseToolInput } from "./tool-input.ts";

test("tool input parser uses the declared schema without accepting extra fields", () => {
  const schema = Type.Object(
    { path: Type.String({ minLength: 1 }), edits: Type.Array(Type.String(), { minItems: 1 }) },
    { additionalProperties: false },
  );
  const valid = { path: "file.txt", edits: ["one"] };
  assert.deepEqual(parseToolInput("example", schema, valid), valid);
  for (const invalid of [
    { path: "file.txt", edits: ["one"], eddits: [] },
    { path: "file.txt", edits: [] },
    { path: "file.txt", edits: '["one"]' },
  ]) {
    assert.throws(
      () => parseToolInput("example", schema, invalid),
      /Validation failed for tool "example"/,
    );
  }
  assert.throws(
    () => parseToolInput("example", schema, { ...valid, eddits: [], endd: "wrong" }),
    (error: Error) => error.message.includes("eddits") && error.message.includes("endd"),
  );
});
