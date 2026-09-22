import { test } from "node:test";
import assert from "node:assert/strict";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { theme } from "../../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js";
import { makeEditOverride } from "./edit-tool.ts";
import { makeReplaceTool } from "./replace-tool.ts";

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
