import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { Type } from "typebox";
import { createCodemodeToolDefinition } from "../../node_modules/@earendil-works/pi-coding-agent/dist/extensions/codemode/tool.js";
import { openTestSession, responseStream, SESSION_TIMEOUT_MS } from "../testing/session.testing.ts";
import { createActionFusionExecutor } from "./action-fusion.ts";
import { makeWriteOverride } from "./write-tool.ts";

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
