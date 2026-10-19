import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import type { ToolCall } from "@earendil-works/pi-ai";
import { loadInstalledExtension } from "../testing/extension-loader.testing.ts";
import { openTestSession, responseStream, SESSION_TIMEOUT_MS } from "../testing/session.testing.ts";
import { decodeReport } from "../pi/report.ts";

test("packed extension completes file, worker, and command operations", {
  timeout: SESSION_TIMEOUT_MS,
}, async (t) => {
  const cwd = process.cwd();
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
    tools: ["write", "read", "grep", "edit", "replace", "bash"],
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
        replacements: [{ find: "(edited)", replace: "$1 after", literal: false }],
      }),
  ];
  let next = 0;
  session.agent.streamFunction = () => {
    const action = actions[next++];
    if (action) return responseStream(model, { content: [action()], stopReason: "toolUse" });
    return responseStream(model, {
      content: [{ type: "text", text: "Done." }],
      stopReason: "stop",
    });
  };
  await session.prompt("Complete the packaged tool workflow.");
  assert.equal(session.agent.state.errorMessage, undefined);
  assert.equal(next, actions.length + 1);
  for (const id of ["write", "read", "grep", "edit", "replace"]) result(id);
  const command = result("write")
    .content.map((block) =>
      block.type === "text" ? decodeReport(block.text, "write")?.then_run : undefined,
    )
    .find((facts) => facts !== undefined);
  assert.equal(command?.status, "succeeded");
  assert.match(command?.output ?? "", /PACKAGE_COMMAND_OK/);
  assert.equal(await readFile(join(cwd, "fixture.txt"), "utf8"), "edited after\nkeep\n");
});
