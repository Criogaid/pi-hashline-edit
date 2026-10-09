import assert from "node:assert/strict";
import { readFile, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { Type } from "typebox";
import { createCodemodeToolDefinition } from "../../node_modules/@earendil-works/pi-coding-agent/dist/extensions/codemode/tool.js";
import { openTestSession, responseStream, SESSION_TIMEOUT_MS } from "../testing/session.testing.ts";
import { createActionFusionExecutor } from "./action-fusion.ts";
import { makeWriteOverride } from "./write-tool.ts";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { theme } from "../../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js";
import { registerFusionCards, withMutationStatus } from "./fusion-card.ts";
import { makeEditOverride } from "./edit-tool.ts";
import { makeReplaceTool } from "./replace-tool.ts";
import { DEFAULT_CONFIG } from "./config.ts";
import { MAX_BLOCK_BYTES } from "./budgets.ts";

for (const entry of ["direct", "codemode"] as const) {
  test(`${entry} mutation waits on then_run → the call and model continuation stay pending`, {
    timeout: SESSION_TIMEOUT_MS,
  }, async (t) => {
    const started = Promise.withResolvers<void>();
    const finished = Promise.withResolvers<void>();
    const { cwd, session, model } = await openTestSession(t, {
      tools: ["write", "bash", "codemode"],
      configure(pi, cwd) {
        pi.registerTool(makeWriteOverride(cwd, createActionFusionExecutor()));
        pi.registerTool(createCodemodeToolDefinition());
        pi.registerTool({
          name: "bash",
          label: "bash",
          description: "Hold the requested command until the test releases it",
          parameters: Type.Object({ command: Type.String() }),
          async execute() {
            started.resolve();
            await finished.promise;
            return { content: [{ type: "text", text: "checked" }], details: undefined };
          },
        });
      },
    });
    const ended: string[] = [];
    session.subscribe((event) => {
      if (event.type === "tool_execution_end") ended.push(event.toolName);
    });
    const args = {
      path: "saved.txt",
      mode: "create",
      content: "saved\n",
      then_run: { command: "held command" },
    };
    let requests = 0;
    session.agent.streamFunction = () => {
      const first = requests++ === 0;
      assert.ok(requests <= 2, "Unexpected model continuation");
      return responseStream(model, {
        content: first
          ? [
              {
                type: "toolCall",
                id: "mutation",
                name: entry === "direct" ? "write" : "codemode",
                arguments:
                  entry === "direct"
                    ? args
                    : {
                        code: `text(await tools.write(${JSON.stringify(args)})); text("AFTER_WRITE");`,
                      },
              },
            ]
          : [{ type: "text", text: "Done." }],
        stopReason: first ? "toolUse" : "stop",
      });
    };
    const pending = session.prompt("Run the mutation and its command.");
    try {
      await started.promise;
      assert.equal(await readFile(join(cwd, "saved.txt"), "utf8"), "saved\n");
      assert.equal(requests, 1, "The model must not continue before then_run ends");
      assert.ok(!ended.includes("write"));
      assert.ok(!ended.includes("codemode"));
    } finally {
      finished.resolve();
      await pending;
    }
    assert.equal(session.agent.state.errorMessage, undefined);
    assert.equal(requests, 2);
    assert.ok(ended.includes("write"));
    const result = session.agent.state.messages.find(
      (message) => message.role === "toolResult" && message.toolCallId === "mutation",
    );
    assert.ok(result?.role === "toolResult");
    assert.equal(result.isError, false);
    if (entry === "codemode") {
      assert.ok(ended.includes("codemode"));
      const output = result.content
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join("\n");
      assert.match(output, /then_run:succeeded[\s\S]*AFTER_WRITE/);
    }
  });
}

async function openFusionCardSession(t: TestContext, command: (text: string) => Promise<string>) {
  return openTestSession(t, {
    tools: ["write", "edit", "replace", "bash", "codemode"],
    configure(pi, cwd) {
      const fusion = createActionFusionExecutor(undefined, registerFusionCards(pi));
      pi.registerTool(withMutationStatus(makeWriteOverride(cwd, fusion)));
      pi.registerTool(withMutationStatus(makeEditOverride(cwd, DEFAULT_CONFIG, fusion)));
      pi.registerTool(withMutationStatus(makeReplaceTool(cwd, DEFAULT_CONFIG, fusion)));
      pi.registerTool(createCodemodeToolDefinition());
      pi.registerTool({
        name: "bash",
        label: "bash",
        description: "Run the test's controlled command",
        parameters: Type.Object({ command: Type.String() }),
        async execute(_id, args) {
          return {
            content: [{ type: "text", text: await command(args.command) }],
            details: undefined,
          };
        },
      });
    },
  });
}

type CardSession = Awaited<ReturnType<typeof openFusionCardSession>>;

function startScript({ session, model }: CardSession, code: string) {
  let requests = 0;
  session.agent.streamFunction = () => {
    const first = requests++ === 0;
    assert.ok(requests <= 2);
    return responseStream(model, {
      content: first
        ? [{ type: "toolCall", id: "fusion-script", name: "codemode", arguments: { code } }]
        : [{ type: "text", text: "Done." }],
      stopReason: first ? "toolUse" : "stop",
    });
  };
  return { pending: session.prompt("Run the script."), requests: () => requests };
}

function renderedCards({ session, sessionManager }: CardSession, customType: string) {
  const renderer = session.extensionRunner.getEntryRenderer(customType);
  assert.ok(renderer, `Missing renderer for ${customType}`);
  return sessionManager.getBranch().flatMap((entry) => {
    if (entry.type !== "custom" || entry.customType !== customType) return [];
    const component = renderer(entry, { expanded: true }, theme);
    assert.ok(component);
    return [{ entry, component, output: component.render(200).join("\n") }];
  });
}

const cardCases = [
  {
    tool: "write",
    before: undefined,
    mutation: { content: "saved\n", mode: "create" },
    expected: "saved\n",
  },
  {
    tool: "edit",
    before: "old\n",
    mutation: { edits: [{ op: "append", body: ["saved"] }] },
    expected: "old\nsaved\n",
  },
  {
    tool: "replace",
    before: "saved\n",
    mutation: { replacements: [{ find: "saved", replace: "saved" }] },
    expected: "saved\n",
  },
] as const;

for (const fixture of cardCases) {
  for (const failed of [false, true]) {
    test(`codemode ${fixture.tool}, command ${failed ? "fails" : "succeeds"} → independent mutation card completes before the script`, {
      timeout: SESSION_TIMEOUT_MS,
    }, async (t) => {
      initTheme("dark");
      const started = Promise.withResolvers<void>();
      const finished = Promise.withResolvers<void>();
      const context = await openFusionCardSession(t, async () => {
        started.resolve();
        await finished.promise;
        if (failed) throw new Error("Command exited with code 7");
        return "checked";
      });
      if (fixture.before !== undefined)
        await writeFile(join(context.cwd, "target.txt"), fixture.before);
      const args = {
        path: "target.txt",
        ...fixture.mutation,
        then_run: { command: "held command" },
      };
      const script = startScript(
        context,
        `text(await tools.${fixture.tool}(${JSON.stringify(args)}));`,
      );
      try {
        await started.promise;
        assert.equal(await readFile(join(context.cwd, "target.txt"), "utf8"), fixture.expected);
        assert.equal(script.requests(), 1);
        const files = renderedCards(context, "hashline-nested-mutation");
        assert.equal(files.length, 1);
        assert.match(files[0].output, /target.txt/);
        assert.ok(files[0].output.includes(theme.getBgAnsi("toolSuccessBg")));
        if (fixture.tool === "replace") assert.match(files[0].output, /no net change/i);
        const commands = renderedCards(context, "hashline-then-run");
        assert.equal(commands.length, 1);
        assert.ok(commands[0].output.includes(theme.getBgAnsi("toolPendingBg")));
      } finally {
        finished.resolve();
        await script.pending;
      }
      assert.equal(script.requests(), 2);
      assert.equal(context.session.agent.state.errorMessage, undefined);
      const files = renderedCards(context, "hashline-nested-mutation");
      const commands = renderedCards(context, "hashline-then-run");
      assert.ok(files[0].output.includes(theme.getBgAnsi("toolSuccessBg")));
      assert.ok(
        commands[0].output.includes(theme.getBgAnsi(failed ? "toolErrorBg" : "toolSuccessBg")),
      );
      await context.session.extensionRunner.emit({
        type: "session_tree",
        oldLeafId: context.sessionManager.getLeafId(),
        newLeafId: context.sessionManager.getLeafId(),
      });
      assert.ok(
        renderedCards(context, "hashline-nested-mutation")[0].output.includes(
          theme.getBgAnsi("toolSuccessBg"),
        ),
      );
      assert.ok(
        renderedCards(context, "hashline-then-run")[0].output.includes(
          theme.getBgAnsi(failed ? "toolErrorBg" : "toolSuccessBg"),
        ),
      );
      assert.ok(!context.session.agent.state.messages.some((message) => message.role === "custom"));
    });
  }
}

test("codemode mutation fails → independent file error and skipped command survive restore", {
  timeout: SESSION_TIMEOUT_MS,
}, async (t) => {
  initTheme("dark");
  let commands = 0;
  const context = await openFusionCardSession(t, async () => {
    commands++;
    return "unexpected";
  });
  const args = {
    path: "missing.txt",
    content: "saved",
    mode: "overwrite",
    then_run: { command: "must not run" },
  };
  await startScript(context, `text(await tools.write(${JSON.stringify(args)}));`).pending;
  assert.equal(commands, 0);
  for (const restored of [false, true]) {
    if (restored)
      await context.session.extensionRunner.emit({
        type: "session_tree",
        oldLeafId: context.sessionManager.getLeafId(),
        newLeafId: context.sessionManager.getLeafId(),
      });
    const files = renderedCards(context, "hashline-nested-mutation");
    assert.equal(files.length, 1);
    assert.ok(files[0].output.includes(theme.getBgAnsi("toolErrorBg")));
    assert.match(files[0].output, /does not exist/);
    const command = renderedCards(context, "hashline-then-run")[0].output;
    assert.match(command, /skipped/);
    assert.ok(!command.includes(theme.getBgAnsi("toolErrorBg")));
  }
});

test("codemode concurrent calls have identical argument previews → file cards remain bound to actual child ids", {
  timeout: SESSION_TIMEOUT_MS,
}, async (t) => {
  initTheme("dark");
  const startedA = Promise.withResolvers<void>();
  const startedB = Promise.withResolvers<void>();
  const finishedA = Promise.withResolvers<void>();
  const finishedB = Promise.withResolvers<void>();
  const context = await openFusionCardSession(t, async (command) => {
    if (command === "hold A") {
      startedA.resolve();
      await finishedA.promise;
    } else {
      startedB.resolve();
      await finishedB.promise;
    }
    return "checked";
  });
  const args = ["A", "B"].map((id) => ({
    content: "x".repeat(500),
    mode: "create",
    path: `${id}.txt`,
    then_run: { command: `hold ${id}` },
  }));
  const script = startScript(
    context,
    `await Promise.all(${JSON.stringify(args)}.map(args => tools.write(args)));`,
  );
  try {
    await Promise.all([startedA.promise, startedB.promise]);
    const files = renderedCards(context, "hashline-nested-mutation");
    assert.equal(files.length, 2);
    assert.notEqual(files[0].entry.id, files[1].entry.id);
    for (const id of ["A", "B"]) {
      const file = files.find((file) => file.output.includes(`${id}.txt`));
      assert.ok(file?.output.includes(theme.getBgAnsi("toolSuccessBg")));
      assert.equal(await readFile(join(context.cwd, `${id}.txt`), "utf8"), "x".repeat(500));
    }
    assert.ok(
      renderedCards(context, "hashline-then-run").every((card) =>
        card.output.includes(theme.getBgAnsi("toolPendingBg")),
      ),
    );
  } finally {
    finishedA.resolve();
    finishedB.resolve();
    await script.pending;
  }
});

for (const freshness of ["changed", "missing"] as const) {
  test(`codemode command leaves target ${freshness} → file success retains a stale-anchor warning after restore`, {
    timeout: SESSION_TIMEOUT_MS,
  }, async (t) => {
    initTheme("dark");
    const context = await openFusionCardSession(t, async () => {
      const path = join(context.cwd, "target.txt");
      if (freshness === "changed") await writeFile(path, "command replacement\n");
      else await unlink(path);
      return "checked";
    });
    const args = {
      path: "target.txt",
      mode: "create",
      content: "saved\n",
      then_run: { command: "change target" },
    };
    await startScript(context, `text(await tools.write(${JSON.stringify(args)}));`).pending;
    for (const restored of [false, true]) {
      if (restored)
        await context.session.extensionRunner.emit({
          type: "session_tree",
          oldLeafId: context.sessionManager.getLeafId(),
          newLeafId: context.sessionManager.getLeafId(),
        });
      const file = renderedCards(context, "hashline-nested-mutation")[0].output;
      assert.ok(file.includes(theme.getBgAnsi("toolSuccessBg")));
      assert.match(file, new RegExp(`Anchors are stale: target ${freshness}`));
    }
  });
}

test("codemode produces an oversized Unicode diff → saved card labels the omitted preview and keeps file success", {
  timeout: SESSION_TIMEOUT_MS,
}, async (t) => {
  initTheme("dark");
  const context = await openFusionCardSession(t, async () => "checked");
  await writeFile(join(context.cwd, "target.txt"), "old\n");
  const content = "中文😀".repeat(MAX_BLOCK_BYTES);
  const args = {
    path: "target.txt",
    edits: [{ op: "append", body: [content] }],
    then_run: { command: "check" },
  };
  await startScript(context, `text(await tools.edit(${JSON.stringify(args)}));`).pending;
  assert.equal(await readFile(join(context.cwd, "target.txt"), "utf8"), `old\n${content}\n`);
  await context.session.extensionRunner.emit({
    type: "session_tree",
    oldLeafId: context.sessionManager.getLeafId(),
    newLeafId: context.sessionManager.getLeafId(),
  });
  const [file] = renderedCards(context, "hashline-nested-mutation");
  assert.ok(file.output.includes(theme.getBgAnsi("toolSuccessBg")));
  assert.match(file.output, /Diff omitted/);
  assert.ok(!file.output.includes("�"));
  const saved = context.sessionManager
    .getBranch()
    .filter(
      (entry) => entry.type === "custom" && entry.customType.startsWith("hashline-nested-mutation"),
    );
  for (const entry of saved)
    assert.ok(Buffer.byteLength(JSON.stringify(entry)) < MAX_BLOCK_BYTES * 2);
});

test("direct fused mutation → native mutation card remains the only file card", {
  timeout: SESSION_TIMEOUT_MS,
}, async (t) => {
  initTheme("dark");
  const context = await openFusionCardSession(t, async () => "checked");
  let requests = 0;
  context.session.agent.streamFunction = () => {
    const first = requests++ === 0;
    return responseStream(context.model, {
      content: first
        ? [
            {
              type: "toolCall",
              id: "direct-file",
              name: "write",
              arguments: {
                path: "target.txt",
                content: "saved",
                mode: "create",
                then_run: { command: "check" },
              },
            },
          ]
        : [{ type: "text", text: "Done." }],
      stopReason: first ? "toolUse" : "stop",
    });
  };
  await context.session.prompt("Run the mutation.");
  assert.equal(await readFile(join(context.cwd, "target.txt"), "utf8"), "saved");
  assert.equal(renderedCards(context, "hashline-nested-mutation").length, 0);
  assert.equal(renderedCards(context, "hashline-then-run").length, 1);
});

test("saved session resumes while a command was unfinished → completed file stays successful and command is interrupted", {
  timeout: SESSION_TIMEOUT_MS,
}, async (t) => {
  initTheme("dark");
  const started = Promise.withResolvers<void>();
  const finished = Promise.withResolvers<void>();
  const context = await openFusionCardSession(t, async () => {
    started.resolve();
    await finished.promise;
    return "checked";
  });
  const args = {
    path: "target.txt",
    mode: "create",
    content: "saved",
    then_run: { command: "held command" },
  };
  const script = startScript(context, `text(await tools.write(${JSON.stringify(args)}));`);
  try {
    await started.promise;
    const resumed = await openFusionCardSession(t, async () => {
      throw new Error("Restoring a card must not execute the command");
    });
    for (const entry of context.sessionManager.getBranch()) {
      if (entry.type === "custom")
        resumed.sessionManager.appendCustomEntry(
          entry.customType,
          JSON.parse(JSON.stringify(entry.data)),
        );
    }
    await resumed.session.extensionRunner.emit({
      type: "session_tree",
      oldLeafId: resumed.sessionManager.getLeafId(),
      newLeafId: resumed.sessionManager.getLeafId(),
    });
    const file = renderedCards(resumed, "hashline-nested-mutation")[0].output;
    assert.ok(file.includes(theme.getBgAnsi("toolSuccessBg")));
    assert.match(file, /File changes saved/);
    const command = renderedCards(resumed, "hashline-then-run")[0].output;
    assert.match(command, /interrupted.*unknown/);
    assert.ok(!command.includes(theme.getBgAnsi("toolPendingBg")));
  } finally {
    finished.resolve();
    await script.pending;
  }
});

test("saved nested file card has an unsupported version → renderer reports invalid data", {
  timeout: SESSION_TIMEOUT_MS,
}, async (t) => {
  initTheme("dark");
  const context = await openFusionCardSession(t, async () => "checked");
  const args = {
    path: "target.txt",
    content: "saved",
    mode: "create",
    then_run: { command: "check" },
  };
  await startScript(context, `text(await tools.write(${JSON.stringify(args)}));`).pending;
  const [file] = renderedCards(context, "hashline-nested-mutation");
  const renderer = context.session.extensionRunner.getEntryRenderer("hashline-nested-mutation");
  assert.ok(renderer);
  const invalid = renderer({ ...file.entry, data: { version: 999 } }, { expanded: true }, theme);
  assert.ok(invalid);
  assert.match(invalid.render(80).join("\n"), /Unsupported or invalid/);
});
