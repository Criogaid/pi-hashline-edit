import assert from "node:assert/strict";
import { test } from "node:test";
import { initTheme, type AgentSession } from "@earendil-works/pi-coding-agent";
import { ProcessTerminal, TuiMainScreen, type TuiMouseEvent } from "@earendil-works/pi-tui";
import { CustomEntryComponent } from "../../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/components/custom-entry.js";
import { theme } from "../../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js";
import { openTestSession } from "../testing/session.testing.ts";
import { registerFusionCards } from "./fusion-card.ts";

const output = Array.from({ length: 20 }, (_, i) => `command output ${i}`).join("\n");

async function bindTui(session: AgentSession) {
  const tui = new TuiMainScreen(new ProcessTerminal());
  tui.requestRender = () => {};
  await session.bindExtensions({
    mode: "tui",
    uiContext: {
      ...session.extensionRunner.createContext().ui,
      setWidget: ((_, content) => {
        if (typeof content === "function") assert.deepEqual(content(tui, theme).render(100), []);
      }) satisfies ReturnType<typeof session.extensionRunner.createContext>["ui"]["setWidget"],
    },
  });
}

test("command cards share native mouse behavior and preserve independent expansion through updates and redraws", async (t) => {
  initTheme("dark");
  let report: ReturnType<typeof registerFusionCards> | undefined;
  const { session, sessionManager } = await openTestSession(t, {
    tools: [],
    configure(pi) {
      report = registerFusionCards(pi);
    },
  });
  await bindTui(session);
  assert.ok(report);
  const progress = {
    toolCallId: "first",
    path: "file.ts",
    commandText: "check",
    command: "running" as const,
    publication: "PUBLISHED" as const,
    freshness: "unchanged" as const,
    result: { content: [{ type: "text" as const, text: output }] },
    mutationCompleted: true,
  };
  report(progress);
  report({ ...progress, toolCallId: "second" });
  const renderer = session.extensionRunner.getEntryRenderer("hashline-then-run");
  assert.ok(renderer);
  const hosts = sessionManager
    .getBranch()
    .filter((entry) => entry.type === "custom" && entry.customType === "hashline-then-run")
    .map((entry) => {
      assert.ok(entry.type === "custom");
      return new CustomEntryComponent(entry, renderer);
    });
  const [first, second] = hosts;
  assert.ok(first && second);
  const rows = first.render(100);
  const event: TuiMouseEvent = {
    type: "click",
    button: "left",
    x: 4,
    y: 2,
    screenX: 4,
    screenY: 2,
    width: 100,
    height: rows.length,
    shift: false,
    alt: false,
    ctrl: false,
  };
  assert.doesNotMatch(rows.join("\n"), /command output 0\b/);
  for (const ignored of [
    { ...event, button: "right" as const },
    ...(["press", "release", "drag", "wheel"] as const).map((type) => ({ ...event, type })),
  ]) {
    assert.equal(first.handleMouse(ignored), undefined);
    assert.deepEqual(first.render(100), rows);
  }
  assert.equal(first.handleMouse(event)?.handled, true);
  assert.match(first.render(100).join("\n"), /command output 0\b/);
  assert.doesNotMatch(second.render(100).join("\n"), /command output 0\b/);
  report({
    ...progress,
    command: "succeeded",
    result: { content: [{ type: "text", text: `${output}\nfinished` }] },
  });
  first.invalidate();
  assert.match(first.render(40).join("\n"), /command output 0\b/);
  assert.match(first.render(100).join("\n"), /finished/);
  first.setExpanded(true);
  first.setExpanded(false);
  assert.doesNotMatch(first.render(100).join("\n"), /command output 0\b/);
  first.setExpanded(true);
  assert.match(first.render(100).join("\n"), /command output 0\b/);
});

test("command entries rebuilt before session_start → remain visible and become interactive after UI binding", async (t) => {
  initTheme("dark");
  let report: ReturnType<typeof registerFusionCards> | undefined;
  const { session, sessionManager } = await openTestSession(t, {
    tools: [],
    configure(pi) {
      report = registerFusionCards(pi);
    },
  });
  assert.ok(report);
  report({
    toolCallId: "restored",
    path: "file.ts",
    commandText: "check",
    command: "succeeded",
    publication: "PUBLISHED",
    freshness: "unchanged",
    result: { content: [{ type: "text", text: output }] },
    mutationCompleted: true,
  });
  const entry = sessionManager
    .getBranch()
    .find((entry) => entry.type === "custom" && entry.customType === "hashline-then-run");
  const renderer = session.extensionRunner.getEntryRenderer("hashline-then-run");
  assert.ok(entry?.type === "custom" && renderer);
  const host = new CustomEntryComponent(entry, renderer);
  assert.equal(host.hasContent(), true, "Pi discards entries without a component during reload");
  await bindTui(session);
  const rows = host.render(100);
  assert.match(rows.join("\n"), /succeeded[\s\S]*command output 19/);
  assert.equal(
    host.handleMouse({
      type: "click",
      button: "left",
      x: 4,
      y: 2,
      screenX: 4,
      screenY: 2,
      width: 100,
      height: rows.length,
      shift: false,
      alt: false,
      ctrl: false,
    })?.handled,
    true,
  );
  assert.match(host.render(100).join("\n"), /command output 0\b/);
});
