import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { registerFusionCards } from "./fusion-card.ts";
import type { ActionFusionProgress } from "./action-fusion.ts";

const theme = { fg: (_color: string, text: string) => text, bg: (_color: string, text: string) => text, bold: (text: string) => text };
const themeKeys = [Symbol.for("@earendil-works/pi-coding-agent:theme"), Symbol.for("@mariozechner/pi-coding-agent:theme")];
const originalThemes = themeKeys.map((key) => Object.getOwnPropertyDescriptor(globalThis, key));
before(() => initTheme("dark"));
after(() => themeKeys.forEach((key, index) => {
	const original = originalThemes[index];
	if (original) Object.defineProperty(globalThis, key, original);
	else Reflect.deleteProperty(globalThis, key);
}));

function harness(entries: any[] = []) {
	const renderers = new Map<string, any>();
	const handlers = new Map<string, any>();
	const backgrounds: string[] = [];
	const report = registerFusionCards({
		on(event: string, handler: any) { handlers.set(event, handler); },
		registerEntryRenderer(type: string, renderer: any) { renderers.set(type, renderer); },
		appendEntry(customType: string, data: unknown) { entries.push({ type: "custom", customType, data: structuredClone(data) }); },
	} as any);
	const restore = (event = "session_start", branch = entries) => handlers.get(event)({}, { sessionManager: { getBranch: () => branch } });
	const card = (entry: any, expanded = false) => renderers.get(entry.customType)(entry, { expanded }, {
		...theme, bg: (color: string, text: string) => { backgrounds.push(color); return text; },
	});
	return { entries, report, restore, card, backgrounds };
}

const waiting: ActionFusionProgress = {
	toolCallId: "call-1", path: "file.ts", commandText: "npm test", command: "waiting",
	publication: "NOT_PUBLISHED", freshness: "unknown", output: "", mutationCompleted: false,
};

test("one independent card updates live and only persists its endpoints", () => {
	const h = harness();
	h.report(waiting);
	const card = h.card(h.entries[0]);
	assert.match(card.render(100).join("\n"), /waiting/);
	assert.equal(h.backgrounds.at(-1), "toolPendingBg");
	h.report({ ...waiting, command: "running", publication: "PUBLISHED", output: "first test passed" });
	assert.match(card.render(100).join("\n"), /running[\s\S]*first test passed/);
	assert.equal(h.entries.length, 1);
	const output = Array.from({ length: 20 }, (_, i) => `output line ${i}`).join("\n");
	h.report({ ...waiting, command: "succeeded", publication: "PUBLISHED", freshness: "changed", output });
	assert.equal(h.entries.length, 2);
	assert.equal(h.entries[0].data.command, "waiting");
	const collapsed = card.render(100).join("\n");
	assert.match(collapsed, /succeeded[\s\S]*Anchors are stale/);
	assert.equal(h.backgrounds.at(-1), "toolSuccessBg");
	assert.match(collapsed, /output line 19/);
	assert.doesNotMatch(collapsed, /output line 0\b/);
	assert.match(h.card(h.entries[0], true).render(100).join("\n"), /output line 0\b/);
});

test("session restore uses final snapshots and marks unfinished calls unknown", () => {
	const h = harness();
	h.report(waiting);
	h.report({ ...waiting, command: "failed", publication: "PUBLISHED", output: "Command exited with code 7" });
	const resumed = harness(h.entries);
	resumed.restore();
	assert.match(resumed.card(h.entries[0]).render(100).join("\n"), /failed[\s\S]*Command exited with code 7/);
	assert.equal(resumed.backgrounds.at(-1), "toolErrorBg");
	resumed.restore("session_tree", [h.entries[0]]);
	assert.match(resumed.card(h.entries[0]).render(100).join("\n"), /interrupted \(final status unknown\)/);
});
