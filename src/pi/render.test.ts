import { test } from "node:test";
import assert from "node:assert/strict";
import { generateDiffString, initTheme } from "@earendil-works/pi-coding-agent";
import { theme } from "../../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js";
import { displayCarriageReturns } from "./anchor-format.ts";
import { makeEditOverride } from "./edit-tool.ts";
import { makeReplaceTool } from "./replace-tool.ts";
import { renderDiffPreview, withMutationStatus } from "./render.ts";
import { makeWriteOverride } from "./write-tool.ts";
import { generateMutationDetails } from "./mutation-result.ts";

test("mutation headers refresh in place and retain isolated per-call counts", () => {
	initTheme("dark");
	for (const tool of [makeEditOverride(process.cwd()), makeReplaceTool(process.cwd())]) {
		const args = { path: "a.txt", edits: [{ op: "append", body: ["new"] }], find: "old", replace: "new" };
		const context: any = { args, state: {}, invalidate() { assert.fail("rendering must not invalidate the row"); } };
		const header = tool.renderCall(args, theme, context);
		const other = tool.renderCall({ ...args, path: "b.txt" }, theme, { state: {} });
		assert.equal(context.state.callText, header);
		tool.renderResult({ content: [{ type: "text", text: "Done" }], details: { diff: "-1 old\n+1 new" } }, { isPartial: false, expanded: false }, theme, context);
		assert.match(header.render(100).join("\n"), /\+1/);
		assert.match(header.render(100).join("\n"), /-1/);
		assert.doesNotMatch(other.render(100).join("\n"), /\+1|-1/);
		context.lastComponent = header;
		assert.equal(tool.renderCall(args, theme, context), header);
		assert.match(header.render(100).join("\n"), /\+1/);
	}
});

test("mutation card owns stale-anchor notices without internal status", () => {
	initTheme("dark");
	const tool = withMutationStatus(makeEditOverride(process.cwd()));
	const args = { path: "a.txt", edits: [{ op: "append", body: ["new"] }] };
	const context: any = { args, state: {}, isPartial: false, isError: false, invalidate() {} };
	const card = tool.renderCall!(args, theme, context);
	tool.renderResult!({
		content: [{ type: "text", text: "Edit saved." }, { type: "text", text: "command diagnostic" }],
		details: { actionFusion: { publication: "PUBLISHED", freshness: "changed", command: "failed" } },
	}, { isPartial: false, expanded: false }, theme, context);
	const output = card.render(160).join("\n");
	assert.match(output, /Edit saved/);
	assert.doesNotMatch(output, /publication=|freshness=/);
	assert.match(output, /Anchors are stale: target changed/);
	assert.doesNotMatch(output, /command diagnostic/);
	assert.ok(output.includes(theme.getBgAnsi("toolSuccessBg")));
});

test("mutation card omits status when then_run was not requested", () => {
	initTheme("dark");
	const tool = withMutationStatus(makeEditOverride(process.cwd()));
	const args = { path: "a.txt", edits: [{ op: "append", body: ["new"] }] };
	const context: any = { args, state: {}, isPartial: false, isError: false, invalidate() {} };
	const card = tool.renderCall!(args, theme, context);
	tool.renderResult!({
		content: [{ type: "text", text: "Edited a.txt." }],
		details: { actionFusion: { publication: "PUBLISHED", freshness: "unchanged", command: "not_requested" } },
	}, { isPartial: false, expanded: false }, theme, context);
	const output = card.render(160).join("\n");
	assert.match(output, /Edited a\.txt/);
	assert.doesNotMatch(output, /publication=|freshness=/);
	tool.renderCall!(args, theme, context);
	tool.renderResult!({
		content: [{ type: "text", text: "Edited a.txt." }],
		details: { actionFusion: { publication: "PUBLISHED", freshness: "changed", command: "not_requested" } },
	}, { isPartial: false, expanded: false }, theme, context);
	const staleOutput = card.render(160).join("\n");
	assert.match(staleOutput, /Anchors are stale: target changed/);
	assert.doesNotMatch(staleOutput, /publication=|freshness=/);
});

test("unfused write errors retain the native full diagnostic", () => {
	initTheme("dark");
	const tool = withMutationStatus(makeWriteOverride(process.cwd()));
	const args = { path: "a.txt", content: "new" };
	const context: any = { args, state: {}, isPartial: false, isError: true, invalidate() {} };
	const card = tool.renderCall!(args, theme, context);
	tool.renderResult!({ content: [{ type: "text", text: "write failed\nimportant detail" }], details: {} },
		{ isPartial: false, expanded: false }, theme, context);
	assert.match(card.render(160).join("\n"), /write failed[\s\S]*important detail/);
});

test("mutation previews hide CRLF boundaries even with mixed endings or an unterminated last line", () => {
	initTheme("dark");
	for (const before of ["old\r\ncontext\r\n", "old\r\ncontext\nlast", "old\r\ncontext\r\nlast"]) {
		const after = before.replace("old", "new");
		const details = generateMutationDetails("a.txt", before, after, { publishedRevision: "r", observedRevision: "r" }, "PUBLISHED");
		assert.equal(details.diff, displayCarriageReturns(generateDiffString(before, after).diff));
		assert.match(details.diff, /␍/);
		assert.ok(details.patch.includes("-old\r\n"));
		for (const tool of [makeEditOverride(process.cwd()), makeReplaceTool(process.cwd())]) {
			for (const expanded of [false, true]) {
				const context: any = { args: { path: "a.txt" }, state: {}, isError: false };
				const rendered = tool.renderResult({ content: [{ type: "text", text: "Done" }], details }, { isPartial: false, expanded }, theme, context);
				const output = rendered.render(160).join("\n");
				assert.doesNotMatch(output, /␍/);
				assert.match(output, /old[\s\S]*new[\s\S]*context/);
			}
		}
	}
});

test("diff previews retain standalone CR and literal control-picture characters", () => {
	initTheme("dark");
	for (const before of ["old\r", "old␍", "old\rcontent\r\n"]) {
		const details = generateMutationDetails("a.txt", before, before.replace("old", "new"), { publishedRevision: "r", observedRevision: "r" }, "PUBLISHED");
		const tool = makeEditOverride(process.cwd());
		const result = tool.renderResult({ content: [], details }, { expanded: true }, theme, { args: { path: "a.txt" }, state: {}, isError: false });
		assert.match(result.render(160).join("\n"), /␍/);
	}
	assert.match(renderDiffPreview("-1 old␍\n+1 new␍", true, theme), /␍/);
});
