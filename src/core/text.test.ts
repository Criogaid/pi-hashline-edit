import { test } from "node:test";
import assert from "node:assert/strict";
import { decodeEditableText, decodeUtf8 } from "./text.ts";

test("decodeUtf8 rejects malformed input instead of replacing bytes", () => {
	assert.throws(() => decodeUtf8(Uint8Array.from([0xc3, 0x28])), /UNSUPPORTED_ENCODING/);
});

test("decodeUtf8 preserves a leading BOM", () => {
	assert.equal(decodeUtf8(Uint8Array.from([0xef, 0xbb, 0xbf, 0x61])), "\ufeffa");
});

test("decodeEditableText rejects NUL bytes", () => {
	assert.throws(() => decodeEditableText(Uint8Array.from([0x61, 0, 0x62])), /UNSUPPORTED_TEXT/);
});
