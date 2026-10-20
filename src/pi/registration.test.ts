import { rejectsArgument } from "./argument-error.testing.ts";
import { createEditTool } from "@earendil-works/pi-coding-agent";
import { validateToolArguments } from "@earendil-works/pi-ai";
import { makeEditOverride } from "./edit-tool.ts";
import { makeReadOverride } from "./read-tool.ts";
import { loadConfig } from "./config.ts";
import { DEFAULT_CONFIG } from "./config.ts";
import { mkdir, mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { test } from "node:test";
import registerHashline from "../index.ts";
import { initTheme } from "@earendil-works/pi-coding-agent";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { ProcessTerminal, TuiMainScreen } from "@earendil-works/pi-tui";
import { ToolExecutionComponent } from "../../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/components/tool-execution.js";
import { theme } from "../../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js";
import { computeLineHash } from "../core/hash.ts";
import { callTool } from "./tool-call.testing.ts";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { ActionFusionProgress } from "./action-fusion.ts";
import { reportOf } from "./report.ts";
import { formatByteSize } from "./budgets.ts";
import { expectToolFailure } from "./report-failure.testing.ts";
import { openTestSession } from "../testing/session.testing.ts";

test("mutation cards use Fusion by default and explicit false removes command support", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hashline-registration-"));
  const previousCwd = process.cwd();
  try {
    await mkdir(join(dir, ".pi"));
    await writeFile(
      join(dir, ".pi", "settings.json"),
      JSON.stringify({ hashlineEdit: { enabled: true } }),
    );
    process.chdir(dir);
    const tools: any[] = [];
    const entries: any[] = [];
    const renderers = new Map<string, any>();
    let start: ((event: unknown, ctx: unknown) => void) | undefined;
    registerHashline({
      on(event: string, handler: (event: unknown, ctx: unknown) => void) {
        if (event === "session_start") start = handler;
      },
      getSettings() {
        return {};
      },
      registerEntryRenderer(type: string, renderer: any) {
        renderers.set(type, renderer);
      },
      appendEntry(customType: string, data: unknown) {
        entries.push({ customType, data });
      },
      registerTool(tool: any) {
        tools.push(tool);
      },
    } as any);
    assert.deepEqual(
      tools.map((tool) => tool.name),
      ["write", "edit", "replace", "read", "grep"],
    );
    const grep = tools.find((tool) => tool.name === "grep");
    assert.deepEqual(Object.keys(grep.parameters.properties).sort(), [
      "context",
      "flags",
      "glob",
      "ignoreCase",
      "limit",
      "literal",
      "multiline",
      "outputMode",
      "path",
      "pattern",
    ]);
    assert.equal(grep.parameters.additionalProperties, false);
    await assert.rejects(
      callTool(grep, { pattern: "needle", literal: true, noIgnore: false }),
      rejectsArgument("noIgnore", /not allowed/),
    );
    for (const tool of tools.filter((tool) => ["edit", "replace", "write"].includes(tool.name))) {
      assert.ok(
        tool.parameters.properties.then_run,
        `${tool.name} should expose then_run when actionFusion is enabled`,
      );
      assert.match(
        tool.description,
        /then_run/,
        `${tool.name} description should mention then_run when actionFusion is enabled`,
      );
    }
    initTheme("dark");
    const tui = new TuiMainScreen(new ProcessTerminal());
    tui.requestRender = () => {};
    assert.ok(start);
    start(
      {},
      {
        cwd: dir,
        mode: "tui",
        sessionManager: { getBranch: () => entries },
        ui: {
          setWidget(_key: string, content: Parameters<ExtensionContext["ui"]["setWidget"]>[1]) {
            if (typeof content === "function") content(tui, theme);
          },
        },
      },
    );
    const cases = [
      { name: "write", args: { content: "published\n", mode: "create" } },
      { name: "edit", args: { edits: [{ op: "append", body: ["appended"] }] } },
      {
        name: "replace",
        args: { replacements: [{ literal: true, find: "published", replace: "published" }] },
      },
    ] as const;
    for (const { name, args } of cases) {
      const tool = tools.find((tool) => tool.name === name);
      const params = { path: "published.txt", ...args, then_run: { command: "exit 7" } };
      const card = new ToolExecutionComponent(name, name, params, {}, tool, tui, dir);
      card.setArgsComplete();
      card.markExecutionStarted();
      const frames: {
        command: string;
        mutationCompleted: boolean;
        output: string;
        commandOutput: string;
        expandedOutput: string;
      }[] = [];
      const result = await callTool(tool, params, {
        toolCallId: name,
        onUpdate: (update: AgentToolResult<{ actionFusion: ActionFusionProgress }>) => {
          card.updateResult({ ...update, isError: false }, true);
          const entry = entries.find(
            (entry) => entry.customType === "hashline-then-run" && entry.data.toolCallId === name,
          );
          const commandCard = renderers.get(entry.customType)(entry, { expanded: false }, theme);
          card.setExpanded(true);
          const expandedOutput = card.render(100).join("\n");
          card.setExpanded(false);
          frames.push({
            ...update.details.actionFusion,
            output: card.render(100).join("\n"),
            commandOutput: commandCard.render(100).join("\n"),
            expandedOutput,
          });
        },
        ctx: { cwd: dir },
      });
      assert.equal(
        reportOf(result, name)?.publication,
        name === "replace" ? "NOT_PUBLISHED" : "PUBLISHED",
      );
      assert.equal(reportOf(result, name)?.then_run?.status, "failed");
      assert.ok(frames[0].output.includes(theme.getBgAnsi("toolPendingBg")));
      const running = frames.find((frame) => frame.command === "running")!;
      assert.ok(running, `${name} should emit running progress`);
      assert.ok(
        running.output.includes(theme.getBgAnsi("toolSuccessBg")),
        `${name} should finish its mutation card while then_run is running`,
      );
      assert.ok(!running.output.includes(theme.getBgAnsi("toolPendingBg")));
      assert.ok(running.commandOutput.includes(theme.getBgAnsi("toolPendingBg")));
      assert.ok(frames.at(-1)!.commandOutput.includes(theme.getBgAnsi("toolErrorBg")));
      const completed = frames.find(
        (frame) => frame.command === "waiting" && frame.mutationCompleted,
      )!;
      assert.ok(
        completed?.output.includes(theme.getBgAnsi("toolSuccessBg")),
        "mutation completion must finish its card before command checks",
      );
      for (const frame of frames) {
        const expectedBackground = theme.getBgAnsi(
          frame.mutationCompleted ? "toolSuccessBg" : "toolPendingBg",
        );
        assert.ok(frame.output.includes(expectedBackground));
        assert.ok(frame.expandedOutput.includes(expectedBackground));
      }
      if (name === "replace") {
        assert.match(running.output, /No diff available/);
      }
      card.updateResult({ ...result, isError: false });
      assert.ok(card.render(100).join("\n").includes(theme.getBgAnsi("toolSuccessBg")));
      if (name === "replace") assert.match(card.render(100).join("\n"), /No net change/);
      card.setExpanded(true);
      assert.doesNotMatch(card.render(100).join("\n"), /publication=|freshness=/);
      assert.doesNotMatch(card.render(100).join("\n"), /Command exited|then_run:failed/);
      assert.doesNotMatch(
        frames.at(-1)!.commandOutput,
        /publication=|freshness=|File changes are saved|No file changes were published|mutation completed/,
      );
      assert.ok(card.render(100).join("\n").includes(theme.getBgAnsi("toolSuccessBg")));

      const invalid = {
        ...params,
        path: "missing.txt",
        ...(name === "write" ? { mode: "overwrite" } : {}),
      };
      const failedCard = new ToolExecutionComponent(
        name,
        `${name}-bad`,
        invalid,
        {},
        tool,
        tui,
        dir,
      );
      const failed = await tool.execute(
        `${name}-bad`,
        invalid,
        undefined,
        (update: AgentToolResult<unknown>) =>
          failedCard.updateResult({ ...update, isError: false }, true),
        { cwd: dir },
      );
      assert.equal(failed.isError, true);
      const report = reportOf(failed, name);
      assert.equal(report?.error, "PATH_NOT_FOUND");
      failedCard.updateResult(failed);
      const output = failedCard.render(100).join("\n");
      assert.ok(
        output.includes(theme.getBgAnsi("toolErrorBg")),
        `${name} mutation failure should turn red`,
      );
      assert.ok(!output.includes(theme.getBgAnsi("toolPendingBg")));
      failedCard.setExpanded(true);
      const expandedError = failedCard.render(400).join("\n");
      assert.ok(expandedError.includes(report?.message ?? ""));
      if (report?.cause?.message) assert.ok(expandedError.includes(report.cause.message));
      assert.match(output, /PATH_NOT_FOUND/);
      const entry = entries.find(
        (entry) =>
          entry.customType === "hashline-then-run" && entry.data.toolCallId === `${name}-bad`,
      );
      const commandOutput = renderers
        .get(entry.customType)(entry, { expanded: true }, theme)
        .render(160)
        .join("\n");
      assert.match(commandOutput, /skipped[\s\S]*Not run.*mutation did not complete/);
      assert.doesNotMatch(commandOutput, /Error reading|does not exist|publication=|freshness=/);
      assert.ok(!commandOutput.includes(theme.getBgAnsi("toolErrorBg")));
    }
    assert.deepEqual(
      entries.map((entry) => entry.data.command),
      cases.flatMap(() => ["waiting", "failed", "waiting", "skipped"]),
    );
    assert.ok(
      entries.every(
        (entry) =>
          !("publication" in entry.data) &&
          !("path" in entry.data) &&
          ["unchanged", "changed", "missing", "unknown"].includes(entry.data.freshness),
      ),
    );
    await writeFile(join(dir, "stale.txt"), "header\ntarget\n");
    const edit = tools.find((tool) => tool.name === "edit");
    const stale = {
      path: "stale.txt",
      edits: [{ op: "replace", anchor: `1#${computeLineHash(1, "target", 4)}`, body: ["changed"] }],
      then_run: { command: "exit 99" },
    };
    const staleCard = new ToolExecutionComponent("edit", "stale", stale, {}, edit, tui, dir);
    const failed = await edit.execute(
      "stale",
      stale,
      undefined,
      (update: AgentToolResult<unknown>) =>
        staleCard.updateResult({ ...update, isError: false }, true),
      { cwd: dir },
    );
    assert.equal(failed.isError, true);
    assert.equal(reportOf(failed, "edit")?.failures?.[0].result, "shifted");
    staleCard.updateResult(failed);
    assert.match(staleCard.render(160).join("\n"), /ANCHOR_MISMATCH/);
    const entry = entries.find(
      (entry) => entry.customType === "hashline-then-run" && entry.data.toolCallId === "stale",
    );
    const commandOutput = renderers
      .get(entry.customType)(entry, { expanded: true }, theme)
      .render(160)
      .join("\n");
    assert.match(commandOutput, /skipped/);
    assert.doesNotMatch(
      commandOutput,
      /ANCHOR_MISMATCH|candidate|Input-anchor|publication=|freshness=/,
    );
    assert.equal(await readFile(join(dir, "stale.txt"), "utf8"), "header\ntarget\n");
    await writeFile(
      join(dir, ".pi", "settings.json"),
      JSON.stringify({ hashlineEdit: { actionFusion: false } }),
    );
    const disabledTools: any[] = [];
    registerHashline({
      on() {},
      registerEntryRenderer() {},
      registerTool(tool: any) {
        disabledTools.push(tool);
      },
    } as any);
    assert.deepEqual(
      disabledTools.map((tool) => tool.name),
      tools.map((tool) => tool.name),
    );
    for (const tool of disabledTools.filter((tool) =>
      ["edit", "replace", "write"].includes(tool.name),
    )) {
      assert.equal(tool.parameters.properties.then_run, undefined);
      assert.equal(tool.renderShell, "default");
      assert.doesNotMatch(tool.description, /then_run/);
      // Without Action Fusion the schema has no then_run, so Pi rejects it before execute.
      await assert.rejects(
        callTool(
          tool,
          { path: "published.txt", then_run: { command: "exit 0" } },
          { ctx: { cwd: dir } },
        ),
        rejectsArgument("then_run", /not allowed/),
      );
    }
  } finally {
    process.chdir(previousCwd);
    await rm(dir, { recursive: true, force: true });
  }
});

async function withDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "hl-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Call a tool through Pi's argument preparation and schema validation, as production does. */
const call = (tool: any, params: any) => callTool(tool, params, { toolCallId: "0" });

/** Extract a `LINE#HASH` anchor from a read/edit result text block. */
function anchorLine(block: string, line: number) {
  const m = new RegExp(`^${line}#([0-9A-Z]+)(?:│|$)`, "m").exec(block);
  if (!m) throw new Error(`line ${line} anchor not found in block`);
  return `${line}#${m[1]}`;
}

test("removed forget setting remains in settings → load succeeds without registering forget", async (t) =>
  withDir(async (dir) => {
    await mkdir(join(dir, ".pi"));
    await writeFile(
      join(dir, ".pi", "settings.json"),
      JSON.stringify({
        hashlineEdit: { forget: true, hashLen: 6, actionFusion: false },
      }),
    );
    assert.deepEqual(loadConfig(dir), { ...DEFAULT_CONFIG, hashLen: 6, actionFusion: false });
    const { session } = await openTestSession(t, {
      cwd: dir,
      tools: ["read", "grep"],
      configure(pi) {
        const previousCwd = process.cwd();
        try {
          process.chdir(dir);
          registerHashline(pi);
        } finally {
          process.chdir(previousCwd);
        }
      },
    });
    assert.ok(session.getToolDefinition("read"));
    assert.ok(session.getToolDefinition("grep"));
    assert.equal(session.getToolDefinition("forget"), undefined);
  }));

test("disabled config registers no tools — built-ins remain", async () => {
  await withDir(async (dir) => {
    const oldCwd = process.cwd();
    try {
      await mkdir(join(dir, ".pi"));
      await writeFile(
        join(dir, ".pi", "settings.json"),
        JSON.stringify({ hashlineEdit: { enabled: false } }),
      );
      await writeFile(join(dir, "f.txt"), "old value\n");
      process.chdir(dir);
      const registered: string[] = [];
      registerHashline({
        on() {},
        registerTool(tool: { name: string }) {
          registered.push(tool.name);
        },
      } as any);
      assert.deepEqual(registered, []);
      const builtin = createEditTool(dir);
      const params = validateToolArguments(builtin, {
        name: "edit",
        arguments: { path: "f.txt", edits: [{ oldText: "old value", newText: "new value" }] },
      } as any);
      await call(builtin, params);
      assert.equal(await readFile(join(dir, "f.txt"), "utf-8"), "new value\n");
    } finally {
      process.chdir(oldCwd);
    }
  });
});

test("loaded configuration controls hash length and recovery radius", async () =>
  withDir(async (dir) => {
    const text = "changed\ntarget\npadding\ntarget\n";
    await mkdir(join(dir, ".pi"));
    await writeFile(join(dir, "configured.txt"), text);
    for (const [hashLen, shiftRadius, expected] of [
      [6, 0, "unresolved"],
      [6, 1, "shifted"],
      [8, 3, "ambiguous"],
    ] as const) {
      await writeFile(
        join(dir, ".pi", "settings.json"),
        JSON.stringify({ hashlineEdit: { hashLen, shiftRadius } }),
      );
      const config = loadConfig(dir);
      const read = await call(makeReadOverride(dir, config), { path: "configured.txt" });
      assert.equal(anchorLine(read.content[0].text, 1).split("#")[1].length, hashLen);
      await expectToolFailure(
        call(makeEditOverride(dir, config), {
          path: "configured.txt",
          edits: [{ op: "delete", anchor: `1#${computeLineHash(1, "target", hashLen)}` }],
        }),
        "ANCHOR_MISMATCH",
        (report) => {
          assert.equal(report.failures?.[0].result, expected);
          if (expected === "shifted") assert.match(report.failures?.[0].candidate ?? "", /^2#/);
        },
      );
      assert.equal(await readFile(join(dir, "configured.txt"), "utf8"), text);
    }
  }));

test("configured read defaults bound omitted limits and returned bytes", async () =>
  withDir(async (dir) => {
    const read = makeReadOverride(dir, {
      ...DEFAULT_CONFIG,
      read: { defaultLimit: 2, maxKiB: 1 },
    });
    const description: unknown = Reflect.get(read.parameters.properties.limit, "description");
    assert.ok(typeof description === "string");
    assert.match(description, /default 2\)/);
    await writeFile(join(dir, "short.txt"), "a\nb\nc\n");
    const paged = await call(read, { path: "short.txt" });
    assert.deepEqual(reportOf(paged, "read")?.pagination, {
      start: 1,
      end: 2,
      totalLines: 3,
      nextOffset: 3,
    });
    assert.match(reportOf(paged, "read")?.next ?? "", /offset.*pagination\.nextOffset/);
    assert.match(paged.content[0].text, /^2#[0-9A-Z]+│b$/m);
    assert.doesNotMatch(paged.content[0].text, /^3#/m);
    const explicit = await call(read, { path: "short.txt", limit: 3 });
    assert.match(explicit.content[0].text, /^3#[0-9A-Z]+│c$/m);
    await writeFile(join(dir, "wide.txt"), `${"x".repeat(2048)}\n`);
    const wide = await call(read, { path: "wide.txt" });
    assert.deepEqual(reportOf(wide, "read")?.lineTooLong, { line: 1, limit: formatByteSize(1024) });
    assert.doesNotMatch(wide.content[0].text, /^\d+#/m);
  }));
