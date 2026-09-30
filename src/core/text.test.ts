import { test } from "node:test";
import assert from "node:assert/strict";
import { createUtf8Decoder, decodeEditableText, decodeUtf8 } from "./text.ts";
import { UNSUPPORTED_ENCODING } from "./errors.ts";

test("decodeUtf8 rejects malformed input instead of replacing bytes", () => {
  assert.throws(() => decodeUtf8(Uint8Array.from([0xc3, 0x28])), /UNSUPPORTED_ENCODING/);
});

test("decodeUtf8 preserves a leading BOM", () => {
  assert.equal(decodeUtf8(Uint8Array.from([0xef, 0xbb, 0xbf, 0x61])), "\ufeffa");
});

test("decodeEditableText rejects NUL bytes", () => {
  assert.throws(() => decodeEditableText(Uint8Array.from([0x61, 0, 0x62])), /UNSUPPORTED_TEXT/);
});

test("streaming UTF-8 decoders preserve a split BOM in strict and lossy modes", () => {
  for (const mode of ["strict", "lossy"] as const) {
    const decode = createUtf8Decoder(mode);
    assert.equal(decode(Uint8Array.from([0xef]), true), "");
    assert.equal(decode(Uint8Array.from([0xbb, 0xbf, 0x61]), true), "\ufeffa");
    assert.equal(decode(), "");
  }
});

test("lossy decoding replaces malformed bytes and flushes incomplete sequences at EOF", () => {
  const decode = createUtf8Decoder("lossy");
  assert.equal(decode(Uint8Array.from([0xef, 0xbb, 0xbf, 0xff, 0xc3, 0x28]), true), "\ufeff��(");
  assert.equal(decode(Uint8Array.from([0xf0]), true), "");
  assert.equal(decode(Uint8Array.from([0x9f]), true), "");
  assert.equal(decode(), "�");
});

test("strict decoding retains the TextDecoder error as the unsupported encoding cause", () => {
  const isEncodingError = (error: unknown) =>
    error instanceof Error &&
    error.message === UNSUPPORTED_ENCODING &&
    error.cause instanceof TypeError;
  assert.throws(() => createUtf8Decoder("strict")(Uint8Array.from([0xff])), isEncodingError);
  const decode = createUtf8Decoder("strict");
  assert.equal(decode(Uint8Array.from([0xf0, 0x9f]), true), "");
  assert.throws(() => decode(), isEncodingError);
});
