import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import type { ToolCall } from "@earendil-works/pi-ai";
import { loadInstalledExtension } from "../testing/extension-loader.testing.ts";
import { openTestSession, responseStream, SESSION_TIMEOUT_MS } from "../testing/session.testing.ts";
import { reportOf } from "../pi/report.ts";

test("installed extension completes file, worker, and command operations", {
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
        steps: [{ action: "replace", anchor: anchor("grep"), lines: ["edited"] }],
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
      block.type === "text" ? reportOf({ content: [block] }, "write")?.then_run : undefined,
    )
    .find((facts) => facts !== undefined);
  assert.equal(command?.status, "succeeded");
  assert.match(command?.output ?? "", /PACKAGE_COMMAND_OK/);
  assert.equal(await readFile(join(cwd, "fixture.txt"), "utf8"), "edited after\nkeep\n");
});

test("installed extension argument failures → precise independent issues and host coercion without input mutation", {
  timeout: SESSION_TIMEOUT_MS,
}, async (t) => {
  const cwd = process.cwd();
  const factory = await loadInstalledExtension(process.argv[2]);
  const { session, model } = await openTestSession(t, {
    cwd,
    tools: ["write", "read", "grep", "edit", "replace"],
    configure: (pi) => factory(pi),
  });
  const cases = [
    {
      name: "grep",
      args: { pattern: "text", literal: true, outputMode: "rows" },
      fields: ["outputMode"],
    },
    {
      name: "replace",
      args: {
        path: "diagnostic.txt",
        mode: "regex",
        replacements: [{ find: "text", replace: "value", literal: true }],
      },
      fields: ["mode"],
    },
    {
      name: "replace",
      args: {
        path: "diagnostic.txt",
        replacements: [{ find: "text", replace: "value", literal: true, mode: "regex" }],
      },
      fields: ["replacements[0].mode"],
    },
    {
      name: "grep",
      args: { pattern: "(", literal: false, flags: "x", outputMode: "rows", context: null },
      fields: ["flags", "outputMode"],
    },
    {
      name: "replace",
      args: {
        path: "diagnostic.txt",
        replacements: [{ find: "(", replace: "value", literal: false, flags: "x", mode: "regex" }],
      },
      fields: ["replacements[0].flags", "replacements[0].mode"],
    },
    {
      name: "read",
      args: { path: "diagnostic.txt", offset: -1, limit: 0 },
      fields: ["offset", "limit"],
    },
    {
      name: "write",
      args: { path: "diagnostic.txt", content: "text", mode: "invalid" },
      fields: ["mode"],
    },
    {
      name: "edit",
      args: { path: "diagnostic.txt", steps: { action: "append", lines: [] } },
      fields: ["steps[0].lines"],
    },
    {
      name: "write",
      args: { path: "diagnostic.txt", content: 42, mode: "create", then_run: null },
      fields: [],
    },
    { name: "read", args: { path: "diagnostic.txt", offset: "1", limit: null }, fields: [] },
    {
      name: "grep",
      args: {
        path: "diagnostic.txt",
        pattern: "42",
        literal: "true",
        flags: null,
        outputMode: "count",
      },
      fields: [],
    },
    {
      name: "replace",
      args: {
        path: "diagnostic.txt",
        replacements: { find: 42, replace: 43, literal: "true", flags: null },
      },
      fields: ["replacements[0].flags"],
    },
    {
      name: "replace",
      args: {
        path: "diagnostic.txt",
        replacements: [{ find: 42, replace: 42, literal: "true", flags: null }],
      },
      fields: [],
    },
    {
      name: "replace",
      args: {
        path: "diagnostic.txt",
        replacements: { find: 42, replace: 43, literal: "true" },
      },
      fields: [],
    },
  ] as const;
  const original = structuredClone(cases);
  let next = 0;
  session.agent.streamFunction = () => {
    const scenario = cases[next++];
    return responseStream(
      model,
      scenario
        ? {
            content: [
              {
                type: "toolCall",
                id: `diagnostic-${next}`,
                name: scenario.name,
                arguments: scenario.args,
              },
            ],
            stopReason: "toolUse",
          }
        : { content: [{ type: "text", text: "Done." }], stopReason: "stop" },
    );
  };
  await session.prompt("Exercise installed argument validation.");
  assert.equal(session.agent.state.errorMessage, undefined);
  assert.equal(next, cases.length + 1);
  for (const [index, scenario] of cases.entries()) {
    const result = session.agent.state.messages.find(
      (message) =>
        message.role === "toolResult" && message.toolCallId === `diagnostic-${index + 1}`,
    );
    assert.ok(result?.role === "toolResult");
    assert.equal(result.isError, scenario.fields.length > 0, JSON.stringify(result));
    if (scenario.fields.length) {
      const report = reportOf(result, scenario.name);
      assert.equal(report?.error, "INVALID_ARGUMENTS");
      assert.deepEqual(
        report?.issues?.map((issue) => issue.field).sort(),
        [...scenario.fields].sort(),
      );
    }
  }
  assert.deepEqual(cases, original);
  assert.equal(await readFile(join(cwd, "diagnostic.txt"), "utf8"), "43");
});
