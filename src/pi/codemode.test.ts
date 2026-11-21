import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { Type } from "typebox";
import { createCodemodeToolDefinition } from "../../node_modules/@earendil-works/pi-coding-agent/dist/extensions/codemode/tool.js";
import { openTestSession, responseStream, SESSION_TIMEOUT_MS } from "../testing/session.testing.ts";
import { createActionFusionScheduler } from "./action-fusion.ts";
import { DEFAULT_CONFIG, makeReadOverride, makeWriteOverride } from "./tool-factories.testing.ts";

for (const entry of ["direct", "codemode"] as const) {
  test(`${entry} mutation waits on then_run → the call and model continuation stay pending`, {
    timeout: SESSION_TIMEOUT_MS,
  }, async (t) => {
    const started = Promise.withResolvers<void>();
    const finished = Promise.withResolvers<void>();
    const { cwd, session, model } = await openTestSession(t, {
      tools: ["write", "bash", "codemode"],
      configure(pi, cwd) {
        pi.registerTool(
          makeWriteOverride(
            cwd,
            createActionFusionScheduler(() => {}),
          ),
        );
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
      assert.match(output, /"then_run":\s*\{\s*"status":\s*"succeeded"[\s\S]*AFTER_WRITE/);
    }
  });
}

test("codemode script reads and writes → receives each success as an object and a failure as a rejection", {
  timeout: SESSION_TIMEOUT_MS,
}, async (t) => {
  const { cwd, session, model } = await openTestSession(t, {
    tools: ["read", "write", "codemode"],
    configure(pi, cwd) {
      pi.registerTool(
        makeReadOverride(cwd, {
          ...DEFAULT_CONFIG,
          read: { ...DEFAULT_CONFIG.read, defaultLimit: 2 },
        }),
      );
      pi.registerTool(makeWriteOverride(cwd));
      pi.registerTool(createCodemodeToolDefinition());
    },
  });
  await writeFile(join(cwd, "rows.txt"), "one\ntwo\nthree\n");
  const code = [
    'const cut = await tools.read({ path: "rows.txt", anchors: false });',
    'const head = await tools.read({ path: "rows.txt", anchors: false, limit: 1 });',
    'const rest = await tools.read({ path: "rows.txt", anchors: false, offset: cut.nextOffset });',
    'let pastEnd = "resolved";',
    "try {",
    '  await tools.read({ path: "rows.txt", anchors: false, offset: 4 });',
    "} catch (error) {",
    "  pastEnd = String(error);",
    "}",
    'const saved = await tools.write({ path: "new.txt", mode: "create", content: "x\\n" });',
    "text(JSON.stringify({ cut, head, rest, pastEnd, saved }));",
  ].join("\n");
  let requests = 0;
  session.agent.streamFunction = () => {
    const first = requests++ === 0;
    assert.ok(requests <= 2, "Unexpected model continuation");
    return responseStream(model, {
      content: first
        ? [{ type: "toolCall", id: "script", name: "codemode", arguments: { code } }]
        : [{ type: "text", text: "Done." }],
      stopReason: first ? "toolUse" : "stop",
    });
  };
  await session.prompt("Read the file in a script.");
  assert.equal(session.agent.state.errorMessage, undefined);
  const result = session.agent.state.messages.find(
    (message) => message.role === "toolResult" && message.toolCallId === "script",
  );
  assert.ok(result?.role === "toolResult");
  const output = result.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n");
  assert.equal(result.isError, false, output);
  const { cut, head, rest, pastEnd, saved } = JSON.parse(
    output.slice(output.indexOf("{"), output.lastIndexOf("}") + 1),
  );
  assert.partialDeepStrictEqual(cut, { text: "one\ntwo", nextOffset: 3 });
  assert.deepEqual(head, { text: "one", nextOffset: 2 });
  assert.deepEqual(rest, { text: "three" });
  assert.match(pastEnd, /OFFSET_PAST_END[\s\S]*"totalLines": 3/);
  assert.deepEqual(saved, { publication: "PUBLISHED" });
  assert.equal(await readFile(join(cwd, "new.txt"), "utf8"), "x\n");
});
