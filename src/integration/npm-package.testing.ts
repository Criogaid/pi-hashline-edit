import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import type { ToolCall } from "@earendil-works/pi-ai";
import { loadInstalledExtension } from "../testing/extension-loader.testing.ts";
import { openTestSession, responseStream, SESSION_TIMEOUT_MS } from "../testing/session.testing.ts";

test("packed extension completes file, worker, command, and context operations", {
  timeout: SESSION_TIMEOUT_MS,
}, async (t) => {
  const cwd = process.cwd();
  await mkdir(join(cwd, ".pi"));
  await writeFile(
    join(cwd, ".pi", "settings.json"),
    JSON.stringify({ hashlineEdit: { forget: true } }),
  );
  await writeFile(join(cwd, "build.log"), "PACKAGE_LOG_CONTENT ".repeat(200));
  await writeFile(
    join(cwd, "check.mjs"),
    [
      'import assert from "node:assert/strict";',
      'import { readFileSync } from "node:fs";',
      'assert.equal(readFileSync("fixture.txt", "utf8"), "before\\nkeep\\n");',
      'console.log("PACKAGE_COMMAND_OK");',
    ].join("\n"),
  );
  const factory = await loadInstalledExtension(process.argv[2]);
  const { session, model } = await openTestSession(t, {
    cwd,
    tools: ["write", "read", "grep", "edit", "replace", "forget", "bash"],
    configure: (pi) => factory(pi),
  });
  const result = (id: string) => {
    const message = session.agent.state.messages.find(
      (message) => message.role === "toolResult" && message.toolCallId === id,
    );
    assert.ok(message?.role === "toolResult", `Missing tool result ${id}`);
    assert.equal(message.isError, false);
    return message;
  };
  const text = (id: string) =>
    result(id)
      .content.filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("\n");
  const anchor = (id: string) => {
    const match = /^(1#[0-9A-Z]+)│before$/m.exec(text(id));
    assert.ok(match, `Missing copied anchor in ${id}`);
    return match[1];
  };
  const call = (id: string, name: string, args: ToolCall["arguments"]): ToolCall => ({
    type: "toolCall",
    id,
    name,
    arguments: args,
  });
  const actions = [
    () =>
      call("write", "write", {
        path: "fixture.txt",
        content: "before\nkeep\n",
        mode: "create",
        then_run: { command: "node check.mjs", timeout: 5 },
      }),
    () => call("read", "read", { path: "fixture.txt" }),
    () => call("grep", "grep", { path: "fixture.txt", pattern: "before", literal: true }),
    () => {
      assert.equal(anchor("grep"), anchor("read"));
      return call("edit", "edit", {
        path: "fixture.txt",
        edits: [{ op: "replace", anchor: anchor("grep"), body: ["edited"] }],
      });
    },
    () =>
      call("replace", "replace", {
        path: "fixture.txt",
        replacements: [{ find: "(edited)", replace: "$1 after", regex: true }],
      }),
    () => call("log-read", "read", { path: "build.log" }),
    () => {
      const tag = /\[result (r[0-9a-f]{5})\]/.exec(text("log-read"));
      assert.ok(tag);
      return call("forget", "forget", { ids: [tag[1]] });
    },
  ];
  let next = 0;
  session.agent.streamFunction = (_model, context) => {
    const action = actions[next++];
    if (action) return responseStream(model, { content: [action()], stopReason: "toolUse" });
    const forgotten = context.messages.find(
      (message) => message.role === "toolResult" && message.toolCallId === "log-read",
    );
    assert.ok(forgotten?.role === "toolResult");
    assert.equal(forgotten.content.length, 1);
    assert.doesNotMatch(JSON.stringify(forgotten.content), /PACKAGE_LOG_CONTENT/);
    assert.match(JSON.stringify(forgotten.content), /forgotten/);
    return responseStream(model, {
      content: [{ type: "text", text: "Done." }],
      stopReason: "stop",
    });
  };
  await session.prompt("Complete the packaged tool workflow.");
  assert.equal(session.agent.state.errorMessage, undefined);
  assert.equal(next, actions.length + 1);
  for (const id of ["write", "read", "grep", "edit", "replace", "forget"]) result(id);
  assert.match(text("write"), /then_run:succeeded[\s\S]*PACKAGE_COMMAND_OK/);
  assert.equal(await readFile(join(cwd, "fixture.txt"), "utf8"), "edited after\nkeep\n");
  assert.equal(await readFile(join(cwd, "build.log"), "utf8"), "PACKAGE_LOG_CONTENT ".repeat(200));
});
