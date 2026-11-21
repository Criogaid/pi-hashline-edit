import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { Type } from "typebox";
import register from "../index.ts";
import { openTestSession, responseStream } from "../testing/session.testing.ts";
import { reportOf } from "../pi/report.ts";

test("session hook changes checked arguments → execute accepts valid edits and rejects invalid fields before I/O", async (t) => {
  const retained = ["accepted"];
  const { cwd, session, model } = await openTestSession(t, {
    tools: ["read", "edit", "grep"],
    async configure(pi) {
      await register(pi);
      pi.on("tool_call", (event) => {
        switch (event.toolCallId) {
          case "valid":
            Object.assign(event.input, { path: "other.txt", anchors: false });
            break;
          case "sparse": {
            const pattern = ["first", "second"];
            delete pattern[0];
            Object.assign(event.input, { pattern });
            break;
          }
          case "shape":
            Object.assign(event.input, { anchors: "false" });
            break;
          case "semantic":
            Object.assign(event.input, {
              steps: [{ action: "append", lines: ["wrong"], anchor: "1#AAAA" }],
            });
            break;
          case "snapshot":
            Object.assign(event.input, { steps: [{ action: "append", lines: retained }] });
            break;
        }
      });
      pi.on("tool_execution_update", (event) => {
        if (event.toolCallId === "snapshot") retained[0] = "late";
      });
    },
  });
  await writeFile(join(cwd, "original.txt"), "original\n");
  await writeFile(join(cwd, "other.txt"), "other\n");
  await writeFile(join(cwd, "snapshot.txt"), "before\n");
  let sent = false;
  session.agent.streamFunction = () => {
    if (sent)
      return responseStream(model, {
        content: [{ type: "text", text: "Done." }],
        stopReason: "stop",
      });
    sent = true;
    return responseStream(model, {
      content: [
        { type: "toolCall", id: "valid", name: "read", arguments: { path: "original.txt" } },
        {
          type: "toolCall",
          id: "sparse",
          name: "grep",
          arguments: { pattern: ["first"], literal: false },
        },
        { type: "toolCall", id: "shape", name: "read", arguments: { path: "original.txt" } },
        {
          type: "toolCall",
          id: "semantic",
          name: "edit",
          arguments: { path: "original.txt", steps: [{ action: "append", lines: ["ok"] }] },
        },
        {
          type: "toolCall",
          id: "snapshot",
          name: "edit",
          arguments: {
            path: "snapshot.txt",
            steps: [{ action: "append", lines: ["before-hook"] }],
            then_run: { command: "true" },
          },
        },
      ],
      stopReason: "toolUse",
    });
  };
  await session.prompt("Read the two files and try the supplied edit.");
  const results = session.agent.state.messages.filter((message) => message.role === "toolResult");
  assert.deepEqual(results[0]?.content, [{ type: "text", text: "other" }]);
  for (const [id, name, field] of [
    ["shape", "read", "anchors"],
    ["sparse", "grep", "pattern[0]"],
    ["semantic", "edit", "steps[0].anchor"],
  ] as const) {
    const result = results.find((message) => message.toolCallId === id);
    assert.ok(result?.isError, id);
    const report = reportOf(result, name);
    assert.equal(report?.error, "INVALID_ARGUMENTS");
    assert.equal(report.issues[0]?.field, field);
  }
  assert.equal(await readFile(join(cwd, "original.txt"), "utf8"), "original\n");
  assert.deepEqual(retained, ["late"]);
  assert.equal(await readFile(join(cwd, "snapshot.txt"), "utf8"), "before\naccepted\n");
});

test("nested read with a changing getter → Pi hooks and execution use the checked offset", async (t) => {
  const path = "getter.txt";
  let reads = 0;
  const args = Object.freeze({
    path,
    limit: 1,
    anchors: false,
    get offset() {
      // Pi records the nested call before Hashline snapshots its arguments.
      return ++reads <= 2 ? 1 : "not an offset";
    },
  });
  const observed: unknown[] = [];
  const { cwd, session, model } = await openTestSession(t, {
    tools: ["read", "read_nested"],
    async configure(pi) {
      await register(pi);
      pi.on("tool_call", (event) => {
        if (event.toolName === "read") observed.push(event.input);
      });
      pi.registerTool({
        name: "read_nested",
        label: "Nested read",
        description: "Read the fixture through a nested call",
        parameters: Type.Object({}),
        async execute(_id, _args, _signal, _onUpdate, ctx) {
          const nested = await ctx.executeTool("read", args);
          return { ...nested.result, isError: nested.isError };
        },
      });
    },
  });
  await writeFile(join(cwd, path), "first\nsecond\n");
  let sent = false;
  session.agent.streamFunction = () => {
    if (sent)
      return responseStream(model, {
        content: [{ type: "text", text: "Done." }],
        stopReason: "stop",
      });
    sent = true;
    return responseStream(model, {
      content: [{ type: "toolCall", id: "parent", name: "read_nested", arguments: {} }],
      stopReason: "toolUse",
    });
  };
  await session.prompt("Read the fixture through the nested tool.");
  const outcome = session.agent.state.messages.find((message) => message.role === "toolResult");
  assert.ok(outcome);
  assert.equal(outcome.isError, false, JSON.stringify(outcome.content));
  assert.deepEqual(observed, [{ path, offset: 1, limit: 1, anchors: false }]);
  assert.deepEqual(outcome.content[0], { type: "text", text: "first" });
});
