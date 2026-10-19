/** Preparation errors transported by Pi and replayed with a fresh tool registration. */
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { stripVTControlCharacters } from "node:util";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { theme } from "../../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js";
import { DEFAULT_CONFIG } from "../pi/config.ts";
import { makeEditOverride } from "../pi/edit-tool.ts";
import { reportOf } from "../pi/report.ts";
import { openTestSession, responseStream } from "../testing/session.testing.ts";

const args = { path: "target.txt", edits: [{ op: "append", body: [] }] };

test("live preparation failure → replays diagnostic after fresh registration", async (t) => {
  initTheme("dark");
  const first = await openTestSession(t, {
    tools: ["edit"],
    configure(pi, cwd) {
      pi.registerTool(makeEditOverride(cwd, DEFAULT_CONFIG));
    },
  });
  await writeFile(join(first.cwd, args.path), "unchanged\n");
  let requests = 0;
  first.session.agent.streamFunction = (_model, context) => {
    if (requests++ === 0) {
      return responseStream(first.model, {
        content: [{ type: "toolCall", id: "invalid-edit", name: "edit", arguments: args }],
        stopReason: "toolUse",
      });
    }
    const result = context.messages.find(
      (message) => message.role === "toolResult" && message.toolCallId === "invalid-edit",
    );
    assert.ok(result?.role === "toolResult");
    assert.equal(result.isError, true);
    assert.equal(reportOf(result, "edit")?.error, "INVALID_ARGUMENTS");
    return responseStream(first.model, {
      content: [{ type: "text", text: "Done." }],
      stopReason: "stop",
    });
  };
  await first.session.prompt("Exercise a rejected edit in an isolated fixture.");
  assert.equal(first.session.agent.state.errorMessage, undefined);
  assert.equal(requests, 2);
  assert.equal(await readFile(join(first.cwd, args.path), "utf8"), "unchanged\n");
  const live = first.session.agent.state.messages.find(
    (message) => message.role === "toolResult" && message.toolCallId === "invalid-edit",
  );
  assert.ok(live?.role === "toolResult");
  const replay = { content: structuredClone(live.content), details: undefined };
  const serialized = JSON.stringify(replay);
  const report = reportOf(replay, "edit");
  assert.equal(report?.issues?.[0].field, "edits[0].body");
  assert.equal(report?.issues?.[0].reason, "is empty");

  const second = await openTestSession(t, {
    tools: ["edit"],
    configure(pi, cwd) {
      pi.registerTool(makeEditOverride(cwd, DEFAULT_CONFIG));
    },
  });
  const tool = second.session.getToolDefinition("edit");
  assert.ok(tool?.renderResult);
  for (const expanded of [false, true]) {
    for (let rendering = 0; rendering < 2; rendering++) {
      const decoded = JSON.parse(serialized);
      const component = tool.renderResult(decoded, { expanded, isPartial: false }, theme, {
        args,
        toolCallId: "invalid-edit",
        cwd: second.cwd,
        state: {},
        invalidate() {},
        lastComponent: undefined,
        executionStarted: true,
        argsComplete: true,
        expanded,
        isPartial: false,
        showImages: false,
        isError: true,
      });
      const shown = stripVTControlCharacters(component.render(240).join("\n"));
      assert.match(shown, /edits\[0\]\.body: is empty/);
      assert.equal(shown.split("edits[0].body: is empty").length - 1, 1);
      assert.doesNotMatch(shown, /"issues":/);
      assert.equal(JSON.stringify(decoded), serialized);
    }
  }
});
