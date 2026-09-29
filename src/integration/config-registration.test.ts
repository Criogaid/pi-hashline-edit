import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import registerHashline from "../index.ts";
import { computeLineHash } from "../core/hash.ts";
import { getState } from "../pi/state.ts";
import { callTool } from "../pi/tool-call.testing.ts";

test("registered tools retain their configuration when another tool set is registered", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "hashline-config-registration-"));
  const previousCwd = process.cwd();
  const state = getState();
  const previousConfig = state.config;
  try {
    await mkdir(join(directory, ".pi"));
    process.chdir(directory);
    const register = async (hashLen: number, shiftRadius: number) => {
      await writeFile(
        join(directory, ".pi", "settings.json"),
        JSON.stringify({
          hashlineEdit: { enabled: true, actionFusion: false, hashLen, shiftRadius },
        }),
      );
      const tools = new Map<string, ToolDefinition>();
      registerHashline({
        on() {},
        registerEntryRenderer() {},
        registerTool(tool: ToolDefinition) {
          tools.set(tool.name, tool);
        },
      } as unknown as ExtensionAPI);
      return { tools, hashLen, shiftRadius };
    };
    const registrations = [await register(6, 1), await register(8, 0)];

    for (const { tools, hashLen, shiftRadius } of registrations) {
      for (const name of ["read", "grep", "replace", "edit"] as const) {
        await t.test(`${name} retains the registered hash length ${hashLen}`, async () => {
          const tool = tools.get(name);
          assert.ok(tool);
          const path = `${hashLen}-${name}.txt`;
          await writeFile(join(directory, path), "before\n");
          const params = {
            read: { path },
            grep: { path, pattern: "before", literal: true },
            replace: { path, replacements: [{ find: "before", replace: "after" }] },
            edit: {
              path,
              edits: [
                {
                  op: "replace",
                  anchor: `1#${computeLineHash(1, "before", hashLen)}`,
                  body: ["after"],
                },
              ],
            },
          }[name];
          const result = await callTool(tool, params);
          const expected = name === "read" || name === "grep" ? "before" : "after";
          const anchor = `1#${computeLineHash(1, expected, hashLen)}`;
          assert.match(result.content[0].text, new RegExp(`^${anchor}(?:│|$)`, "m"));
          assert.equal(await readFile(join(directory, path), "utf8"), `${expected}\n`);
        });
      }

      await t.test(`edit retains the registered recovery radius ${shiftRadius}`, async () => {
        const tool = tools.get("edit");
        assert.ok(tool);
        const path = `${hashLen}-recovery.txt`;
        const text = "changed\ntarget\n";
        await writeFile(join(directory, path), text);
        await assert.rejects(
          callTool(tool, {
            path,
            edits: [{ op: "delete", anchor: `1#${computeLineHash(1, "target", hashLen)}` }],
          }),
          shiftRadius === 0
            ? /no checksum-matching candidate found/
            : /checksum-matching candidate 2#/,
        );
        assert.equal(await readFile(join(directory, path), "utf8"), text);
      });
    }
  } finally {
    process.chdir(previousCwd);
    state.config = previousConfig;
    await rm(directory, { recursive: true, force: true });
  }
});
