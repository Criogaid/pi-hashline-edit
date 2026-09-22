import assert from "node:assert/strict";
import { test } from "node:test";
import { computeLineHash } from "../core/hash.ts";
import { ANCHOR_PATTERN, createAnchorFormatter } from "./anchor-format.ts";
import { getState } from "./state.ts";

test("anchor formatter snapshots configured hash length and hashes undisplayed content", () => {
	const state = getState();
	const previous = state.config;
	try {
		state.config = { ...previous, hashLen: 6 };
		const formatter = createAnchorFormatter();
		state.config = { ...previous, hashLen: 4 };

		assert.equal(formatter.hashLen, 6);
		assert.equal(formatter.token(3, "full content"), `3#${computeLineHash(3, "full content", 6)}`);
		assert.equal(formatter.reference(3, "ABCDEF"), "3#ABCDEF");
		assert.match(formatter.token(3, "full content"), new RegExp(ANCHOR_PATTERN));
		assert.equal(formatter.row(3, "full content", "full…"), `3#${computeLineHash(3, "full content", 6)}│full…`);
		assert.equal(createAnchorFormatter().hashLen, 4);
	} finally {
		state.config = previous;
	}
});

test("anchor rows expose carriage returns while checksums retain source content", () => {
	const formatter = createAnchorFormatter(4);
	assert.equal(formatter.row(1, "a\rb"), `1#${computeLineHash(1, "a\rb", 4)}│a␍b`);
	assert.notEqual(formatter.token(1, "a\rb"), formatter.token(1, "a␍b"));
});
