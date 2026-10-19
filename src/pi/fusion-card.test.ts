import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { registerFusionCards } from "./fusion-card.ts";
import type { ActionFusionProgress } from "./action-fusion.ts";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { ProcessTerminal, TuiMainScreen } from "@earendil-works/pi-tui";
import { theme as activeTheme } from "../../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js";

const themeKey = Symbol.for("@earendil-works/pi-coding-agent:theme");
const originalTheme = Object.getOwnPropertyDescriptor(globalThis, themeKey);
before(() => initTheme("dark"));
after(() => {
  if (originalTheme) Object.defineProperty(globalThis, themeKey, originalTheme);
  else Reflect.deleteProperty(globalThis, themeKey);
});

function harness(entries: any[] = []) {
  const renderers = new Map<string, any>();
  const handlers = new Map<string, any>();
  const tui = new TuiMainScreen(new ProcessTerminal());
  tui.requestRender = () => {};
  const report = registerFusionCards({
    getSettings() {
      return {};
    },
    on(event: string, handler: any) {
      handlers.set(event, handler);
    },
    registerEntryRenderer(type: string, renderer: any) {
      renderers.set(type, renderer);
    },
    appendEntry(customType: string, data: unknown) {
      entries.push({ type: "custom", customType, data: structuredClone(data) });
    },
  } as any);
  const restore = (event = "session_start", branch = entries, extra = {}) =>
    handlers.get(event)(
      {},
      {
        mode: "tui",
        ui: {
          setWidget(_key: string, content: Parameters<ExtensionContext["ui"]["setWidget"]>[1]) {
            if (typeof content === "function") content(tui, activeTheme);
          },
        },
        sessionManager: { getBranch: () => branch },
        ...extra,
      },
    );
  const card = (entry: any, expanded = false) =>
    renderers.get(entry.customType)(entry, { expanded }, activeTheme);
  restore();
  return { entries, report, restore, card };
}

const waiting: ActionFusionProgress = {
  toolCallId: "call-1",
  path: "file.ts",
  commandText: "npm test",
  command: "waiting",
  publication: "NOT_PUBLISHED",
  freshness: "unknown",
  output: "",
  mutationCompleted: false,
};

test("one independent card updates live and only persists its endpoints", () => {
  const h = harness();
  h.report(waiting);
  const card = h.card(h.entries[0]);
  assert.match(card.render(100).join("\n"), /waiting/);
  assert.ok(card.render(100).join("\n").includes(activeTheme.getBgAnsi("toolPendingBg")));
  h.report({
    ...waiting,
    command: "running",
    publication: "PUBLISHED",
    output: "first test passed",
  });
  assert.match(card.render(100).join("\n"), /running[\s\S]*first test passed/);
  assert.equal(h.entries.length, 1);
  const output = Array.from({ length: 20 }, (_, i) => `output line ${i}`).join("\n");
  h.report({
    ...waiting,
    command: "succeeded",
    publication: "PUBLISHED",
    freshness: "changed",
    output,
  });
  assert.equal(h.entries.length, 2);
  assert.equal(h.entries[0].data.command, "waiting");
  const collapsed = card.render(100).join("\n");
  assert.match(collapsed, /succeeded/);
  assert.doesNotMatch(collapsed, /publication=|freshness=|Anchors are stale|file\.ts/);
  assert.ok(collapsed.includes(activeTheme.getBgAnsi("toolSuccessBg")));
  assert.match(collapsed, /output line 19/);
  assert.doesNotMatch(collapsed, /output line 0\b/);
  assert.match(h.card(h.entries[0], true).render(100).join("\n"), /output line 0\b/);
});

test("session restore uses final snapshots and marks unfinished calls unknown", () => {
  const h = harness();
  h.report(waiting);
  h.report({
    ...waiting,
    command: "failed",
    publication: "PUBLISHED",
    output: "Command exited with code 7",
    result: {
      content: [{ type: "text", text: "Command exited with code 7" }],
      details: { fullOutputPath: "/tmp/command-output.log" },
    },
  });
  const resumed = harness(h.entries);
  resumed.restore();
  assert.match(
    resumed.card(h.entries[0]).render(100).join("\n"),
    /failed[\s\S]*Command exited with code 7[\s\S]*command-output\.log/,
  );
  assert.ok(
    resumed
      .card(h.entries[0])
      .render(100)
      .join("\n")
      .includes(activeTheme.getBgAnsi("toolErrorBg")),
  );
  resumed.restore("session_tree", [h.entries[0]]);
  assert.match(
    resumed.card(h.entries[0]).render(100).join("\n"),
    /interrupted \(final status unknown\)/,
  );
});

test("skips and cancellations stay neutral and restore their own reason", () => {
  for (const command of ["skipped", "cancelled"] as const) {
    const h = harness();
    h.report(waiting);
    h.report({ ...waiting, command, mutationCompleted: false });
    for (const restored of [false, true]) {
      const view = restored ? harness(h.entries) : h;
      if (restored) view.restore();
      const output = view.card(h.entries[0], true).render(160).join("\n");
      assert.match(
        output,
        command === "skipped" ? /Not run: the mutation did not complete/ : /Not run: cancelled/,
      );
      assert.doesNotMatch(output, /publication=|freshness=|\(no output\)/);
      assert.ok(!output.includes(activeTheme.getBgAnsi("toolErrorBg")));
      assert.ok(!output.includes(activeTheme.getBgAnsi("toolSuccessBg")));
      assert.ok(output.includes(activeTheme.getBgAnsi("customMessageBg")));
    }
  }
});

test("timed command cards show remaining seconds only while actively running", () => {
  const h = harness();
  h.report(waiting);
  const card = h.card(h.entries[0]);
  assert.doesNotMatch(card.render(160).join("\n"), /remaining/);
  const running: ActionFusionProgress = {
    ...waiting,
    command: "running",
    publication: "PUBLISHED",
    mutationCompleted: true,
    timing: { timeoutSeconds: 10, remainingSeconds: 10 },
  };
  h.report(running);
  assert.match(card.render(160).join("\n"), /10s remaining/);
  h.report({ ...running, timing: { timeoutSeconds: 10, remainingSeconds: 7 } });
  assert.match(card.render(160).join("\n"), /7s remaining/);
  assert.equal(h.entries.length, 1);
  h.report({ ...running, timing: { timeoutSeconds: 10, remainingSeconds: 0 } });
  assert.match(card.render(160).join("\n"), /0s remaining/);
  h.report({ ...running, command: "timeout", output: "Command timed out after 10 seconds" });
  assert.doesNotMatch(card.render(160).join("\n"), /remaining/);
  const restored = harness(h.entries);
  restored.restore();
  assert.doesNotMatch(restored.card(h.entries[0]).render(160).join("\n"), /remaining/);
});

test("invalid persisted command snapshots → do not replace valid progress or become executable cards", () => {
  const original = harness();
  original.report(waiting);
  const initial = original.entries[0];
  for (const invalid of [
    ...["mutationCompleted", "freshness"].map((missing) =>
      Object.fromEntries(
        Object.entries({ ...initial.data, command: "succeeded" }).filter(
          ([key]) => key !== missing,
        ),
      ),
    ),
    { ...initial.data, command: "not-a-command-status" },
    { ...initial.data, freshness: "fresh" },
    { ...initial.data, mutationCompleted: "yes" },
    { ...initial.data, timing: { timeoutSeconds: -1, remainingSeconds: 2 } },
    { ...initial.data, timing: { timeoutSeconds: 3, remainingSeconds: "2" } },
    { ...initial.data, foreign: true },
  ]) {
    const malformed = { ...initial, data: invalid };
    const resumed = harness([initial, { ...malformed, customType: "hashline-then-run-result" }]);
    resumed.restore();
    assert.equal(resumed.card(malformed), undefined);
    const shown = resumed.card(initial).render(160).join("\n");
    assert.match(shown, /interrupted \(final status unknown\)/);
    assert.doesNotMatch(shown, /not-a-command-status|remaining/);
  }
});
