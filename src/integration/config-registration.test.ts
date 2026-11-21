import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { test } from "node:test";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import registerHashline from "../index.ts";
import { computeLineHash } from "../core/hash.ts";
import { callTool } from "../pi/tool-call.testing.ts";
import { type HashlineEditConfig } from "../pi/config.ts";
import { DEFAULT_CONFIG } from "../pi/tool-factories.testing.ts";
import { reportOf } from "../pi/report.ts";
import { formatByteSize } from "../pi/budgets.ts";
import { expectToolFailure } from "../pi/report-failure.testing.ts";
import { openTestSession } from "../testing/session.testing.ts";

test("relative Node preload → registration uses the workspace", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "hashline-workspace-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const previous = process.env.NODE_OPTIONS;
  process.env.NODE_OPTIONS = "--require=./package.json";
  try {
    const { session } = await openTestSession(t, {
      cwd,
      tools: ["read"],
      configure: registerHashline,
    });
    assert.ok(session.getToolDefinition("read")?.prepareArguments);
  } finally {
    if (previous === undefined) delete process.env.NODE_OPTIONS;
    else process.env.NODE_OPTIONS = previous;
  }
});

test("SDK cwd differs from process cwd → project settings and relative tools use the workspace", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "hashline-目录 % & 😀-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const settings = join(cwd, ".pi", "settings.json");
  await mkdir(join(cwd, ".pi"));
  await writeFile(settings, JSON.stringify({ hashlineEdit: { hashLen: 8, actionFusion: false } }));
  await writeFile(join(cwd, "workspace.txt"), "from the SDK workspace\n");
  const hostCwd = process.cwd();
  assert.notEqual(cwd, hostCwd);
  const workspaceQueries: { command: string; code: number }[] = [];
  const { session } = await openTestSession(t, {
    cwd,
    tools: ["read", "write", "edit"],
    configure: (pi) =>
      registerHashline({
        ...pi,
        async exec(command, args, options) {
          const result = await pi.exec(command, args, options);
          workspaceQueries.push({ command: basename(command), code: result.code });
          return result;
        },
      }),
  });
  if (process.platform === "win32") {
    assert.equal(workspaceQueries[0]?.command, "cscript.exe");
    if (workspaceQueries[0]?.code === 0) assert.equal(workspaceQueries.length, 1);
  }
  await session.bindExtensions({ onError: ({ error }) => assert.fail(error) });
  const read = session.getToolDefinition("read");
  assert.ok(read);
  const result = await callTool(read, { path: "workspace.txt" }, { ctx: { cwd } });
  const anchor = `1#${computeLineHash(1, "from the SDK workspace", 8)}`;
  assert.ok(
    result.content.some((block) => block.type === "text" && block.text.includes(anchor)),
    JSON.stringify(result.content),
  );
  const write = session.getToolDefinition("write");
  assert.ok(write && Type.IsObject(write.parameters));
  assert.ok(!("then_run" in write.parameters.properties));
  const written = await callTool(
    write,
    { path: "workspace.txt", content: "written\n", mode: "overwrite" },
    { ctx: { cwd } },
  );
  assert.equal(reportOf(written, "write")?.publication, "PUBLISHED");
  assert.equal(await readFile(join(cwd, "workspace.txt"), "utf8"), "written\n");

  let replayChecks = 0;
  await session.reload({
    beforeSessionStart: () => {
      assert.ok(session.getToolDefinition("edit")?.prepareArguments);
      assert.ok(session.extensionRunner.getEntryRenderer("hashline-then-run"));
      replayChecks++;
    },
  });

  await writeFile(settings, JSON.stringify({ hashlineEdit: { enabled: false } }));
  await session.reload({
    beforeSessionStart: () => {
      assert.equal(session.getToolDefinition("replace"), undefined);
      assert.equal(session.extensionRunner.getEntryRenderer("hashline-then-run"), undefined);
      replayChecks++;
    },
  });
  assert.equal(replayChecks, 2);
  const builtin = session.getToolDefinition("edit");
  assert.ok(builtin && Type.IsObject(builtin.parameters));
  assert.ok("edits" in builtin.parameters.properties);
  assert.equal(process.cwd(), hostCwd);
});

test("registered tools retain their configuration when another tool set is registered", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "hashline-config-registration-"));
  try {
    await mkdir(join(directory, ".pi"));
    const register = async (config: HashlineEditConfig) => {
      await writeFile(
        join(directory, ".pi", "settings.json"),
        JSON.stringify({ hashlineEdit: config }),
      );
      const tools = new Map<string, ToolDefinition>();
      await registerHashline({
        async exec() {
          return { stdout: directory, stderr: "", code: 0, killed: false, truncated: false };
        },
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
          grep: { ...DEFAULT_CONFIG.grep, defaultLimit: 1, defaultContext: 1 },
          replace: { regexTimeoutMs: 3_000 },
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
          grep: { ...DEFAULT_CONFIG.grep, defaultLimit: 2, defaultContext: 0 },
          replace: { regexTimeoutMs: 3_500 },
        })),
        expectedGrepLines: [2, 6],
      },
    ];

    for (const { tools, config, expectedGrepLines } of registrations) {
      const { hashLen, shiftRadius, read, grep, replace } = config;
      for (const name of ["read", "grep", "edit"] as const) {
        await t.test(`${name} retains the registered hash length ${hashLen}`, async () => {
          const tool = tools.get(name);
          assert.ok(tool);
          const path = `${hashLen}-${name}.txt`;
          await writeFile(join(directory, path), "before\n");
          const params = {
            read: { path },
            grep: { path, pattern: "before", literal: true },
            edit: {
              path,
              steps: [
                {
                  action: "replace",
                  anchor: `1#${computeLineHash(1, "before", hashLen)}`,
                  lines: ["after"],
                },
              ],
            },
          }[name];
          const result = await callTool(tool, params);
          assert.equal(result.content[0].type, "text");
          const expected = name === "edit" ? "after" : "before";
          if (name === "edit") {
            assert.equal(result.isError, undefined);
          } else {
            const anchor = `1#${computeLineHash(1, expected, hashLen)}`;
            assert.match(result.content[0].text, new RegExp(`^${anchor}(?:│|$)`, "m"));
          }
          assert.equal(await readFile(join(directory, path), "utf8"), `${expected}\n`);
        });
      }

      await t.test(`edit retains the registered recovery radius ${shiftRadius}`, async () => {
        const tool = tools.get("edit");
        assert.ok(tool);
        const path = `${hashLen}-recovery.txt`;
        const text = "changed\ntarget\n";
        await writeFile(join(directory, path), text);
        await expectToolFailure(
          callTool(tool, {
            path,
            steps: [{ action: "delete", anchor: `1#${computeLineHash(1, "target", hashLen)}` }],
          }),
          "ANCHOR_MISMATCH",
          (report) => {
            const failure = report.failures?.[0];
            assert.equal(failure?.result, shiftRadius === 0 ? "unresolved" : "shifted");
            if (failure.result === "shifted") assert.match(failure.candidate, /^2#/);
          },
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
          assert.equal(result.content[0].type, "text");
          assert.deepEqual(
            result.content[0].text.split("\n").filter((line: string) => /^\d+#/.test(line)),
            lines
              .slice(0, read.defaultLimit)
              .map(
                (content, index) =>
                  `${index + 1}#${computeLineHash(index + 1, content, hashLen)}│${content}`,
              ),
          );
          assert.equal(reportOf(result, "read")?.nextOffset, read.defaultLimit + 1);

          const wide = "界".repeat(500);
          await writeFile(join(directory, path), `${wide}\n`);
          const bounded = await callTool(tool, { path });
          assert.equal(bounded.content[0].type, "text");
          if (read.maxKiB === 1) {
            const maxBytes = read.maxKiB * 1024;
            assert.equal(reportOf(bounded, "read")?.lineTooLong, formatByteSize(maxBytes));
            assert.doesNotMatch(bounded.content[0].text, /^\d+#/m);
          } else {
            assert.ok(
              bounded.content[0].text.includes(`1#${computeLineHash(1, wide, hashLen)}│${wide}`),
            );
            assert.equal(reportOf(bounded, "read")?.outputLimit, undefined);
            assert.equal(reportOf(bounded, "read")?.nextOffset, undefined);
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
          assert.equal(result.content[0].type, "text");
          assert.deepEqual(
            result.content[0].text.split("\n").filter((line: string) => /^\d+#/.test(line)),
            expectedGrepLines.map(
              (line) =>
                `${line}#${computeLineHash(line, lines[line - 1], hashLen)}│${lines[line - 1]}`,
            ),
          );
          assert.equal(reportOf(result, "grep")?.matchLimit, grep.defaultLimit);
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
          await expectToolFailure(
            callTool(tool, {
              path,
              replacements: [{ find: "^(a+)+$", replace: "changed", literal: false }],
            }),
            "REGEX_TIMEOUT",
            (report) => {
              assert.equal(report.timeoutMs, replace.regexTimeoutMs);
              assert.equal(report.publication, "NOT_PUBLISHED");
            },
          );
          assert.equal(await readFile(join(directory, path), "utf8"), original);
        },
      );
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
