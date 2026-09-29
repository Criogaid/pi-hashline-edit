import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import registerHashline from "../index.ts";
import { computeLineHash } from "../core/hash.ts";
import { callTool } from "../pi/tool-call.testing.ts";
import { DEFAULT_CONFIG, type HashlineEditConfig } from "../pi/config.ts";

test("registered tools retain their configuration when another tool set is registered", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "hashline-config-registration-"));
  const previousCwd = process.cwd();
  try {
    await mkdir(join(directory, ".pi"));
    process.chdir(directory);
    const register = async (config: HashlineEditConfig) => {
      await writeFile(
        join(directory, ".pi", "settings.json"),
        JSON.stringify({ hashlineEdit: config }),
      );
      const tools = new Map<string, ToolDefinition>();
      registerHashline({
        on() {},
        registerEntryRenderer() {},
        registerTool(tool: ToolDefinition) {
          tools.set(tool.name, tool);
        },
      } as unknown as ExtensionAPI);
      return { tools, config };
    };
    const registrations = [
      {
        ...(await register({
          ...DEFAULT_CONFIG,
          actionFusion: false,
          hashLen: 6,
          shiftRadius: 1,
          read: { defaultLimit: 1, maxKiB: 1 },
          grep: { defaultLimit: 1, defaultContext: 1 },
          replace: { regexTimeoutMs: 1_000 },
        })),
        expectedGrepLines: [1, 2, 3],
      },
      {
        ...(await register({
          ...DEFAULT_CONFIG,
          actionFusion: false,
          hashLen: 8,
          shiftRadius: 0,
          read: { defaultLimit: 2, maxKiB: 2 },
          grep: { defaultLimit: 2, defaultContext: 0 },
          replace: { regexTimeoutMs: 1_500 },
        })),
        expectedGrepLines: [2, 6],
      },
    ];

    for (const { tools, config, expectedGrepLines } of registrations) {
      const { hashLen, shiftRadius, read, grep, replace } = config;
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

      await t.test(
        `read retains registered limit ${read.defaultLimit} and budget ${read.maxKiB} KiB`,
        async () => {
          const tool = tools.get("read");
          assert.ok(tool);
          const path = `${hashLen}-read-settings.txt`;
          const lines = ["first", "second", "third"];
          await writeFile(join(directory, path), `${lines.join("\n")}\n`);
          const result = await callTool(tool, { path });
          assert.deepEqual(
            result.content[0].text.split("\n").filter((line: string) => /^\d+#/.test(line)),
            lines
              .slice(0, read.defaultLimit)
              .map(
                (content, index) =>
                  `${index + 1}#${computeLineHash(index + 1, content, hashLen)}│${content}`,
              ),
          );
          assert.equal(result.details.pagination.nextOffset, read.defaultLimit + 1);

          const wide = "界".repeat(500);
          await writeFile(join(directory, path), `${wide}\n`);
          const bounded = await callTool(tool, { path });
          if (read.maxKiB === 1) {
            assert.match(bounded.content[0].text, /line 1 exceeds 1 KiB/);
            assert.equal(bounded.details.truncation.maxBytes, 1024);
            assert.equal(bounded.details.truncation.outputBytes, 0);
          } else {
            assert.ok(
              bounded.content[0].text.includes(`1#${computeLineHash(1, wide, hashLen)}│${wide}`),
            );
            assert.equal(bounded.details, undefined);
          }
        },
      );

      await t.test(
        `grep retains registered limit ${grep.defaultLimit} and context ${grep.defaultContext}`,
        async () => {
          const tool = tools.get("grep");
          assert.ok(tool);
          const path = `${hashLen}-grep-settings.txt`;
          const lines = [
            "before one",
            "needle one",
            "after one",
            "gap",
            "before two",
            "needle two",
            "after two",
            "gap",
            "before three",
            "needle three",
            "after three",
          ];
          await writeFile(join(directory, path), `${lines.join("\n")}\n`);
          const result = await callTool(tool, { path, pattern: "needle", literal: true });
          assert.deepEqual(
            result.content[0].text.split("\n").filter((line: string) => /^\d+#/.test(line)),
            expectedGrepLines.map(
              (line) =>
                `${line}#${computeLineHash(line, lines[line - 1], hashLen)}│${lines[line - 1]}`,
            ),
          );
          assert.match(
            result.content[0].text,
            new RegExp(`${grep.defaultLimit} matches limit reached`),
          );
        },
      );

      await t.test(
        `replace retains registered regex timeout ${replace.regexTimeoutMs}ms`,
        async () => {
          const tool = tools.get("replace");
          assert.ok(tool);
          const path = `${hashLen}-replace-settings.txt`;
          const original = `${"a".repeat(35)}!`;
          await writeFile(join(directory, path), original);
          await assert.rejects(
            callTool(tool, {
              path,
              replacements: [{ find: "^(a+)+$", replace: "changed", regex: true }],
            }),
            (error: unknown) =>
              error instanceof Error &&
              error.message ===
                `Replace ${path}: regex evaluation timed out after ${replace.regexTimeoutMs}ms`,
          );
          assert.equal(await readFile(join(directory, path), "utf8"), original);
        },
      );
    }
  } finally {
    process.chdir(previousCwd);
    await rm(directory, { recursive: true, force: true });
  }
});
