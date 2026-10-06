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
import { ToolExecutionComponent } from "../../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/components/tool-execution.js";
import { theme } from "../../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js";
import { computeLineHash } from "../core/hash.ts";
import { callTool } from "./tool-call.testing.ts";

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
    registerHashline({
      on() {},
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
      /Validation failed for tool "grep":\n {2}- noIgnore: schema is false/,
    );
    for (const tool of tools.filter((tool) => ["edit", "replace", "write"].includes(tool.name))) {
      assert.ok(
        tool.parameters.properties.then_run,
        `${tool.name} should expose then_run when actionFusion is enabled`,
      );
    }
    initTheme("dark");
    const cases = [
      { name: "write", args: { content: "published\n", mode: "create" } },
      { name: "edit", args: { edits: [{ op: "append", body: ["appended"] }] } },
      { name: "replace", args: { replacements: [{ find: "published", replace: "published" }] } },
    ];
    for (const { name, args } of cases) {
      const tool = tools.find((tool) => tool.name === name);
      const params = { path: "published.txt", ...args, then_run: { command: "exit 7" } };
      const card = new ToolExecutionComponent(
        name,
        name,
        params,
        {},
        tool,
        { requestRender() {} } as any,
        dir,
      );
      card.setArgsComplete();
      card.markExecutionStarted();
      const frames: {
        command: string;
        publication: string;
        mutationCompleted: boolean;
        output: string;
        commandOutput: string;
      }[] = [];
      const result = await tool.execute(
        name,
        params,
        undefined,
        (update: any) => {
          card.updateResult({ ...update, isError: false }, true);
          const entry = entries.find(
            (entry) => entry.customType === "hashline-then-run" && entry.data.toolCallId === name,
          );
          const commandCard = renderers.get(entry.customType)(entry, { expanded: false }, theme);
          frames.push({
            ...update.details.actionFusion,
            output: card.render(100).join("\n"),
            commandOutput: commandCard.render(100).join("\n"),
          });
        },
        { cwd: dir },
      );
      assert.equal(result.details.actionFusion.command, "failed");
      assert.match(result.content[1].text, /File changes are saved|No file changes were published/);
      assert.ok(frames[0].output.includes(theme.getBgAnsi("toolPendingBg")));
      const running = frames.find((frame) => frame.command === "running")!;
      assert.ok(running, `${name} should emit running progress`);
      assert.ok(
        running.output.includes(theme.getBgAnsi("toolSuccessBg")),
        `${name} should turn green before then_run ends`,
      );
      assert.ok(!running.output.includes(theme.getBgAnsi("toolPendingBg")));
      assert.ok(running.commandOutput.includes(theme.getBgAnsi("toolPendingBg")));
      assert.ok(frames.at(-1)!.commandOutput.includes(theme.getBgAnsi("toolErrorBg")));
      const completed = frames.find(
        (frame) => frame.command === "waiting" && frame.mutationCompleted,
      )!;
      assert.ok(
        completed?.output.includes(theme.getBgAnsi("toolSuccessBg")),
        "mutation completion must repaint before command checks",
      );
      if (name === "replace") assert.equal(running.publication, "NOT_PUBLISHED");
      card.updateResult({ ...result, isError: false });
      assert.ok(card.render(100).join("\n").includes(theme.getBgAnsi("toolSuccessBg")));
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
        { requestRender() {} } as any,
        dir,
      );
      await assert.rejects(
        tool.execute(
          `${name}-bad`,
          invalid,
          undefined,
          (update: any) => {
            failedCard.updateResult({ ...update, isError: false }, true);
          },
          { cwd: dir },
        ),
        (error: Error) => {
          failedCard.updateResult({
            content: [{ type: "text", text: error.message }],
            isError: true,
          });
          const output = failedCard.render(100).join("\n");
          assert.ok(
            output.includes(theme.getBgAnsi("toolErrorBg")),
            `${name} mutation failure should turn red`,
          );
          assert.ok(!output.includes(theme.getBgAnsi("toolPendingBg")));
          failedCard.setExpanded(true);
          const expandedError = failedCard.render(400).join("\n");
          for (const line of error.message.split("\n")) {
            assert.ok(expandedError.includes(line), `${name} hid a failure diagnostic`);
          }
          assert.match(output, name === "write" ? /does not exist/ : /Error reading/);
          const entry = entries.find(
            (entry) =>
              entry.customType === "hashline-then-run" && entry.data.toolCallId === `${name}-bad`,
          );
          const commandOutput = renderers
            .get(entry.customType)(entry, { expanded: true }, theme)
            .render(160)
            .join("\n");
          assert.match(
            commandOutput,
            /skipped[\s\S]*Not run because the mutation did not complete/,
          );
          assert.doesNotMatch(
            commandOutput,
            /Error reading|does not exist|publication=|freshness=/,
          );
          assert.ok(!commandOutput.includes(theme.getBgAnsi("toolErrorBg")));
          return true;
        },
      );
    }
    assert.deepEqual(
      entries.map((entry) => entry.data.command),
      cases.flatMap(() => ["waiting", "failed", "waiting", "skipped"]),
    );
    assert.ok(
      entries.every(
        (entry) =>
          !("publication" in entry.data) && !("freshness" in entry.data) && !("path" in entry.data),
      ),
    );
    await writeFile(join(dir, "stale.txt"), "header\ntarget\n");
    const edit = tools.find((tool) => tool.name === "edit");
    const stale = {
      path: "stale.txt",
      edits: [{ op: "replace", anchor: `1#${computeLineHash(1, "target", 4)}`, body: ["changed"] }],
      then_run: { command: "exit 99" },
    };
    const staleCard = new ToolExecutionComponent(
      "edit",
      "stale",
      stale,
      {},
      edit,
      { requestRender() {} } as any,
      dir,
    );
    await assert.rejects(
      edit.execute(
        "stale",
        stale,
        undefined,
        (update: any) => staleCard.updateResult({ ...update, isError: false }, true),
        { cwd: dir },
      ),
      (error: Error) => {
        assert.match(error.message, /checksum-matching candidate/);
        staleCard.updateResult({ content: [{ type: "text", text: error.message }], isError: true });
        assert.match(staleCard.render(160).join("\n"), /Anchor mismatch/);
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
          /Anchor mismatch|candidate|Input-anchor|publication=|freshness=/,
        );
        return true;
      },
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
      // Without Action Fusion the schema has no then_run, so Pi rejects it before execute.
      await assert.rejects(
        callTool(
          tool,
          { path: "published.txt", then_run: { command: "exit 0" } },
          { ctx: { cwd: dir } },
        ),
        /Validation failed for tool "(edit|replace|write)":[\s\S]*- then_run: schema is false/,
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
      [6, 0, /no checksum-matching candidate found/],
      [6, 1, /checksum-matching candidate 2#/],
      [8, 3, /ambiguous checksum matches/],
    ] as const) {
      await writeFile(
        join(dir, ".pi", "settings.json"),
        JSON.stringify({ hashlineEdit: { hashLen, shiftRadius } }),
      );
      const config = loadConfig(dir);
      const read = await call(makeReadOverride(dir, config), { path: "configured.txt" });
      assert.equal(anchorLine(read.content[0].text, 1).split("#")[1].length, hashLen);
      await assert.rejects(
        call(makeEditOverride(dir, config), {
          path: "configured.txt",
          edits: [{ op: "delete", anchor: `1#${computeLineHash(1, "target", hashLen)}` }],
        }),
        expected,
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
    assert.deepEqual(paged.details.pagination, { start: 1, end: 2, totalLines: 3, nextOffset: 3 });
    assert.match(paged.content[0].text, /offset 3/);
    assert.match(paged.content[0].text, /^2#[0-9A-Z]+│b$/m);
    assert.doesNotMatch(paged.content[0].text, /^3#/m);
    const explicit = await call(read, { path: "short.txt", limit: 3 });
    assert.match(explicit.content[0].text, /^3#[0-9A-Z]+│c$/m);
    await writeFile(join(dir, "wide.txt"), `${"x".repeat(2048)}\n`);
    const wide = await call(read, { path: "wide.txt" });
    assert.equal(wide.details.truncation.firstLineExceedsLimit, true);
    assert.equal(wide.details.truncation.outputLines, 0);
    assert.equal(wide.details.truncation.maxBytes, 1024);
    assert.equal(wide.details.truncation.outputBytes, 0);
  }));
