import { Value } from "typebox/value";
import { ACTION_FUSION_PROGRESS_SCHEMA } from "./report-schema.ts";
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
    commandText: "check",
    command: "running" as const,
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
    commandText: "check",
    command: "succeeded",
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

const commandCard = {
  toolCallId: "owned",
  commandText: "check",
  command: "running" as const,
  freshness: "unchanged" as const,
  mutationCompleted: true,
};

test("synchronous entry subscriber rewrites command output → live card retains the observed result", async (t) => {
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
  report(commandCard);
  const entry = sessionManager.getBranch().find((e) => e.type === "custom");
  const renderer = session.extensionRunner.getEntryRenderer("hashline-then-run");
  assert.ok(entry?.type === "custom" && renderer);
  const host = new CustomEntryComponent(entry, renderer);
  const content = [{ type: "text" as const, text: "original output" }];
  session.subscribe((event) => {
    if (
      event.type === "entry_appended" &&
      event.entry.type === "custom" &&
      event.entry.customType === "hashline-then-run-result"
    ) {
      const { data } = event.entry;
      assert.ok(Value.Check(ACTION_FUSION_PROGRESS_SCHEMA, data));
      const block = data.result?.content[0];
      assert.ok(block?.type === "text");
      block.text = "subscriber output";
    }
  });
  report({ ...commandCard, command: "succeeded", result: { content } });
  content[0].text = "producer output";
  assert.match(host.render(100).join("\n"), /original output/);
});

test("foreign command entries → renderer and branch restore reject unusable snapshots", async (t) => {
  initTheme("dark");
  const { session, sessionManager } = await openTestSession(t, {
    tools: [],
    configure(pi) {
      registerFusionCards(pi);
    },
  });
  const start = sessionManager.appendCustomEntry("hashline-then-run", commandCard);
  const entry = sessionManager.getEntry(start);
  const renderer = session.extensionRunner.getEntryRenderer("hashline-then-run");
  assert.ok(entry?.type === "custom" && renderer);
  for (const result of [
    { content: Object.assign([], { filter: 0 }) },
    { content: Object.assign([], { every: 0 }) },
    {
      get content() {
        throw undefined;
      },
    },
  ]) {
    const bad = { ...commandCard, command: "failed", result };
    sessionManager.appendCustomEntry("hashline-then-run-result", bad);
    assert.equal(new CustomEntryComponent({ ...entry, data: bad }, renderer).hasContent(), false);
  }
  await bindTui(session);
  assert.match(new CustomEntryComponent(entry, renderer).render(100).join("\n"), /interrupted/);
  const override = {
    ...commandCard,
    toolCallId: "override",
    result: {
      content: [{ type: "text", text: "override output" }],
      details: { fullOutputPath: { toString: 0 } },
    },
  };
  assert.match(
    new CustomEntryComponent({ ...entry, data: override }, renderer).render(100).join("\n"),
    /override output/,
  );
});

test("foreign entry discriminator throws → restore still reads the following command outcome", async (t) => {
  initTheme("dark");
  const { session, sessionManager } = await openTestSession(t, {
    tools: [],
    configure(pi) {
      registerFusionCards(pi);
    },
  });
  const start = sessionManager.appendCustomEntry("hashline-then-run", commandCard);
  for (const key of ["type", "customType"]) {
    const id = sessionManager.appendCustomEntry("foreign", {});
    const entry = sessionManager.getEntry(id);
    assert.ok(entry);
    Object.defineProperty(entry, key, {
      get() {
        throw undefined;
      },
    });
  }
  sessionManager.appendCustomEntry("hashline-then-run-result", {
    ...commandCard,
    command: "succeeded",
  });
  await bindTui(session);
  const entry = sessionManager.getEntry(start);
  const renderer = session.extensionRunner.getEntryRenderer("hashline-then-run");
  assert.ok(entry?.type === "custom" && renderer);
  assert.match(new CustomEntryComponent(entry, renderer).render(100).join("\n"), /succeeded/);
});
