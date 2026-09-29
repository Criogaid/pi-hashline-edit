import assert from "node:assert/strict";
import { test } from "node:test";
import { computeLineHash } from "../core/hash.ts";
import {
  anchorPattern,
  createAnchorFormatter,
  parseAnchorToken,
  parseHashline,
} from "./anchor-format.ts";

test("anchor formatter binds the supplied hash length and hashes undisplayed content", () => {
  const formatter = createAnchorFormatter(6);
  const shortFormatter = createAnchorFormatter(4);

  assert.equal(formatter.token(3, "full content"), `3#${computeLineHash(3, "full content", 6)}`);
  assert.equal(formatter.reference(3, "ABCDEF"), "3#ABCDEF");
  assert.match(formatter.token(3, "full content"), new RegExp(anchorPattern(6)));
  assert.doesNotMatch(formatter.token(3, "full content"), new RegExp(anchorPattern(4)));
  assert.equal(
    formatter.row(3, "full content", "full…"),
    `3#${computeLineHash(3, "full content", 6)}│full…`,
  );
  assert.equal(
    shortFormatter.token(3, "full content"),
    `3#${computeLineHash(3, "full content", 4)}`,
  );
});

test("anchor tokens parse at any hash length so wrong lengths can be explained", () => {
  assert.deepEqual(parseAnchorToken("12#GF"), { line: 12, hash: "GF" });
  assert.deepEqual(parseAnchorToken("12#GFYR"), { line: 12, hash: "GFYR" });
  assert.equal(parseAnchorToken("12#gfyr"), undefined);
  assert.equal(parseAnchorToken("0#GFYR"), undefined);
});

test("anchor rows expose carriage returns while checksums retain source content", () => {
  const formatter = createAnchorFormatter(4);
  assert.equal(formatter.row(1, "a\rb"), `1#${computeLineHash(1, "a\rb", 4)}│a␍b`);
  assert.notEqual(formatter.token(1, "a\rb"), formatter.token(1, "a␍b"));
});

test("anchor syntax rejects characters absent from the checksum alphabet", () => {
  const pattern = new RegExp(anchorPattern(4));
  for (const hash of ["IIII", "LLLL", "OOOO", "UUUU", "abcd"]) {
    assert.doesNotMatch(`1#${hash}`, pattern);
    assert.equal(parseAnchorToken(`1#${hash}`), undefined);
    assert.equal(parseHashline(`1#${hash}│content`), null);
  }
});

test("display rows accept supported hash lengths and preserve nested anchor-like content", () => {
  for (const hashLen of [2, 4, 6, 8]) {
    const formatter = createAnchorFormatter(hashLen);
    assert.deepEqual(parseHashline(formatter.row(12, "12#abc│content")), {
      lineNo: "12",
      content: "12#abc│content",
    });
  }
  for (const row of ["0#ABCD│text", "01#ABCD│text", "12#A│text", "12#AAAAAAAAA│text"]) {
    assert.equal(parseHashline(row), null);
  }
});
