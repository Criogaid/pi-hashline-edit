import { commandCompletion, commandOutput, type SessionCommand } from "./action-fusion.testing.ts";
import { rejectsArgument } from "./argument-error.testing.ts";
import { computeLineHash } from "../core/hash.ts";
import { pairwise } from "../testing/pairwise.testing.ts";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { outputBudgetsFor } from "./budgets.ts";
import { createActionFusionScheduler } from "./action-fusion.ts";
import { runAlone } from "./mutation-runner.ts";
import { makeReplaceTool } from "./tool-factories.testing.ts";
import { makeWriteOverride } from "./tool-factories.testing.ts";
import { makeEditOverride } from "./tool-factories.testing.ts";
import { reportOf } from "./report.ts";

import { callTool, createToolContext as ctx } from "./tool-call.testing.ts";
import { DEFAULT_CONFIG } from "./tool-factories.testing.ts";

const text = (result: Pick<AgentToolResult<unknown>, "content">): string =>
  result.content.map((block) => (block.type === "text" ? block.text : "")).join("\n");

const anchorBudget = outputBudgetsFor(4096);
const anchorBatchSize: unknown = Reflect.get(
  makeEditOverride(process.cwd(), DEFAULT_CONFIG).parameters.properties.steps,
  "maxItems",
);
assert.ok(typeof anchorBatchSize === "number");

function assertFailureByteBudgets(message: string): void {
  const report = reportOf({ content: [{ type: "text", text: message }] }, "edit");
  assert.ok(report);
  assert.equal(report.error, "ANCHOR_MISMATCH");
  assert.ok(report.failures && report.failures.length > 0);
  assert.ok(Buffer.byteLength(JSON.stringify(report.failures)) <= anchorBudget.blockBytes);
  assert.equal(report.failures.length + (report.omittedFailures ?? 0), anchorBatchSize);
  assert.ok(report.omittedFailures);
  assert.ok(report.next?.includes("intended target"));
  if (report.candidateNeighborhoods) {
    const rows = report.candidateNeighborhoods.flatMap((group) => group.rows);
    assert.ok(rows.length > 0);
    assert.ok(Buffer.byteLength(rows.join("\n")) + 1 <= anchorBudget.blockBytes);
  }
}

test("edit and replace commands change or remove the file → withhold anchors and report freshness", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "hashline-result-"));
  try {
    const context = await ctx(dir, t);
    for (const [toolName, state, fails] of pairwise(
      ["edit", "replace"] as const,
      ["changed", "missing", "unknown"] as const,
      [false, true] as const,
    )) {
      const path = join(dir, `${toolName}-${state}-${fails}.txt`);
      await writeFile(path, "before\n");
      const updates: AgentToolResult<unknown>[] = [];
      const executeTool: SessionCommand = async (_name, _input, options) => {
        if (state === "changed") await writeFile(path, "command output\n");
        else {
          await rm(path);
          if (state === "unknown") await mkdir(path);
        }
        options?.onUpdate?.({
          content: [{ type: "text", text: "progress" }],
          details: undefined,
        });
        if (fails)
          return commandCompletion({ content: [{ type: "text", text: "command failed" }] }, true);
        return commandCompletion({ content: [{ type: "text", text: "done" }] });
      };
      const fusion = createActionFusionScheduler(() => {});
      const tool =
        toolName === "edit"
          ? makeEditOverride(dir, DEFAULT_CONFIG, fusion)
          : makeReplaceTool(dir, DEFAULT_CONFIG, fusion);
      const args =
        toolName === "edit"
          ? {
              steps: [
                {
                  action: "replace",
                  anchor: `1#${computeLineHash(1, "before", DEFAULT_CONFIG.hashLen)}`,
                  lines: ["after"],
                },
              ],
            }
          : { replacements: [{ literal: true, find: "before", replace: "after" }] };
      const result = await callTool(
        tool,
        { path, ...args, then_run: { command: "check" } },
        {
          onUpdate: (update: AgentToolResult<unknown>) => updates.push(update),
          ctx: { ...context, executeTool },
        },
      );
      assert.doesNotMatch(text(result), /Updated anchors|\d+#[0-9A-Z]+│/);
      const report = reportOf(result, toolName);
      assert.equal(report?.freshness, state);
      assert.equal(report?.publication, "PUBLISHED");
      if (state === "missing") assert.equal(report?.next, undefined);
      else assert.match(report?.next ?? "", /Read the file before further edits/);
      assert.equal(report?.then_run?.status, fails ? "failed" : "succeeded");
      assert.equal(commandOutput(result), fails ? "command failed" : "done");
      assert.equal(result.content.length, 2);
      assert.ok(updates.length > 0);
      for (const update of updates)
        assert.doesNotMatch(text(update), /Updated anchors|\d+#[0-9A-Z]+│/);
      if (state === "changed") assert.equal(await readFile(path, "utf8"), "command output\n");
      else if (state === "missing") await assert.rejects(stat(path), { code: "ENOENT" });
      else assert.equal((await stat(path)).isDirectory(), true);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("progress callback failures → preserve publication and allow the command", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "hashline-progress-"));
  try {
    const context = await ctx(dir, t);
    for (const callback of ["reporter", "update"]) {
      let commands = 0;
      const fail = () => {
        throw new Error("display unavailable");
      };
      const executeTool: SessionCommand = async () => {
        commands++;
        return commandCompletion({ content: [{ type: "text", text: "done" }] });
      };
      const fusion = createActionFusionScheduler(callback === "reporter" ? fail : () => {});
      const path = join(dir, callback);
      const result = await callTool(
        makeWriteOverride(dir, fusion),
        {
          path,
          content: "saved\n",
          mode: "create",
          then_run: { command: "check" },
        },
        {
          onUpdate: callback === "update" ? fail : undefined,
          ctx: { ...context, executeTool },
        },
      );
      assert.equal(commands, 1);
      assert.equal(await readFile(path, "utf8"), "saved\n");
      const report = reportOf(result, "write");
      assert.equal(report?.publication, "PUBLISHED");
      assert.equal(report?.then_run?.status, "succeeded");
      assert.equal(report?.progressError?.message, "display unavailable");
      assert.doesNotMatch(text(result), /display unavailable/);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("aggregate anchor diagnostics → respect their byte budgets", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "hashline-budget-"));
  try {
    const path = join(dir, "long.txt");
    await writeFile(path, "current\n");
    const failure = await callTool(
      makeEditOverride(dir, DEFAULT_CONFIG, undefined, () => anchorBudget),
      {
        path,
        steps: Array.from({ length: anchorBatchSize }, () => ({
          action: "delete",
          anchor: "1#XXXX",
        })),
      },
      { ctx: await ctx(dir, t) },
    );
    assert.equal(failure.isError, true);
    assertFailureByteBudgets(text(failure));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("unpaired surrogate arguments are rejected before Fusion", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "hashline-unicode-"));
  try {
    let commands = 0;
    const events: string[] = [];
    const executeTool: SessionCommand = async () => {
      commands++;
      return commandCompletion({ content: [{ type: "text", text: "done" }] });
    };
    const fusion = createActionFusionScheduler((event) => events.push(event.command));
    const path = join(dir, "file.txt");
    await writeFile(path, "original\n");
    const cases = [
      {
        tool: makeEditOverride(dir, DEFAULT_CONFIG, fusion),
        args: {
          path,
          steps: [{ action: "append", lines: ["\ud800"] }],
          then_run: { command: "check" },
        },
        field: "steps[0].lines[0]",
      },
      {
        tool: makeReplaceTool(dir, DEFAULT_CONFIG, fusion),
        args: {
          path,
          replacements: [{ literal: true, find: "original", replace: "\udfff" }],
          then_run: { command: "check" },
        },
        field: "replacements[0].replace",
      },
      {
        tool: makeWriteOverride(dir, fusion),
        args: { path, content: "\ud800", mode: "overwrite", then_run: { command: "check" } },
        field: "content",
      },
    ];
    for (const { tool, args, field } of cases) {
      await assert.rejects(
        callTool(tool, args, { ctx: { ...(await ctx(dir, t)), executeTool } }),
        (error: unknown) =>
          error instanceof Error &&
          rejectsArgument(field, /encoded losslessly/)(error) &&
          !("publication" in error),
      );
      assert.equal(await readFile(path, "utf8"), "original\n");
    }
    assert.deepEqual(events, []);
    assert.equal(commands, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("ambiguous recovery bounds candidate lists and never claims content identity", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "hashline-candidates-"));
  try {
    const path = join(dir, "file.txt");
    const lines = Array.from({ length: 100 }, () => "same");
    lines[49] = "different";
    await writeFile(path, lines.join("\n"));
    const failure = await callTool(
      makeEditOverride(dir, DEFAULT_CONFIG, undefined, () => anchorBudget),
      {
        path,
        steps: Array.from({ length: anchorBatchSize }, () => ({
          action: "delete",
          anchor: `50#${computeLineHash(50, "same", 4)}`,
        })),
      },
      { ctx: await ctx(dir, t) },
    );
    assert.equal(failure.isError, true);
    assertFailureByteBudgets(text(failure));
    const report = reportOf(failure, "edit");
    assert.ok(
      report?.failures?.every((entry) => entry.result === "ambiguous" && entry.omittedCandidates),
    );
    assert.doesNotMatch(text(failure), /same content/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("NUL arguments are rejected before Fusion for all mutation tools", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "hashline-nul-"));
  try {
    const path = join(dir, "file.txt");
    await writeFile(path, "original\n");
    let commands = 0;
    const events: string[] = [];
    const executeTool: SessionCommand = async () => {
      commands++;
      return commandCompletion({ content: [{ type: "text", text: "unexpected" }] });
    };
    const fusion = createActionFusionScheduler((event) => events.push(event.command));
    const cases = [
      {
        tool: makeEditOverride(dir, DEFAULT_CONFIG, fusion),
        args: {
          path,
          steps: [{ action: "append", lines: ["\0"] }],
          then_run: { command: "check" },
        },
        field: "steps[0].lines[0]",
      },
      {
        tool: makeReplaceTool(dir, DEFAULT_CONFIG, fusion),
        args: {
          path,
          replacements: [{ literal: true, find: "original", replace: "\0" }],
          then_run: { command: "check" },
        },
        field: "replacements[0].replace",
      },
      {
        tool: makeWriteOverride(dir, fusion),
        args: { path, content: "\0", mode: "overwrite", then_run: { command: "check" } },
        field: "content",
      },
    ];
    for (const { tool, args, field } of cases) {
      await assert.rejects(
        callTool(tool, args, { ctx: { ...(await ctx(dir, t)), executeTool } }),
        (error: unknown) =>
          error instanceof Error &&
          rejectsArgument(field, /NUL/)(error) &&
          !("publication" in error),
      );
      assert.equal(await readFile(path, "utf8"), "original\n");
    }
    assert.deepEqual(events, []);
    assert.equal(commands, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("Fusion skips the command when a replacement produces unencodable text", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "hashline-derived-unicode-"));
  try {
    const path = join(dir, "file.txt");
    const before = "😀\n";
    await writeFile(path, before);
    let commands = 0;
    const events: string[] = [];
    const executeTool: SessionCommand = async () => {
      commands++;
      return commandCompletion({ content: [{ type: "text", text: "unexpected" }] });
    };
    const fusion = createActionFusionScheduler((event) => events.push(event.command));
    const result = await callTool(
      makeReplaceTool(dir, DEFAULT_CONFIG, fusion),
      {
        path,
        replacements: [{ find: "^.", replace: "x", literal: false }],
        then_run: { command: "check" },
      },
      { ctx: { ...(await ctx(dir, t)), executeTool } },
    );
    assert.equal(result.isError, true);
    assert.equal(reportOf(result, "replace")?.error, "INVALID_UNICODE");
    assert.equal(reportOf(result, "replace")?.publication, "NOT_PUBLISHED");
    assert.equal(reportOf(result, "replace")?.then_run?.status, "skipped");
    assert.deepEqual(events, ["waiting", "skipped"]);
    assert.equal(await readFile(path, "utf8"), before);
    assert.equal(commands, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

type Scheduler = Parameters<typeof makeWriteOverride>[1];
const noOpCases = [
  {
    makeTool: (cwd: string, schedule?: Scheduler) =>
      makeEditOverride(cwd, DEFAULT_CONFIG, schedule),
    params: {
      steps: [
        {
          action: "replace",
          anchor: `1#${computeLineHash(1, "same", DEFAULT_CONFIG.hashLen)}`,
          lines: ["same"],
        },
      ],
    },
  },
  {
    makeTool: (cwd: string, schedule?: Scheduler) => makeReplaceTool(cwd, DEFAULT_CONFIG, schedule),
    params: { replacements: [{ literal: true, find: "same", replace: "same" }] },
  },
  { makeTool: makeWriteOverride, params: { content: "same\n", mode: "overwrite" } },
];

test("all mutation tools succeed without rewriting on no-op, with and without Fusion", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "hashline-noop-"));
  try {
    const context = await ctx(dir, t);
    for (const { makeTool, params } of noOpCases) {
      for (const mode of ["standalone", "fusion", "command"]) {
        const path = join(dir, "same.txt");
        await writeFile(path, "same\n");
        const before = await stat(path);
        let commands = 0;
        const executeTool: SessionCommand = async () => {
          commands++;
          return commandCompletion({ content: [{ type: "text", text: "checked" }] });
        };
        const fusion = createActionFusionScheduler(() => {});
        const tool = makeTool(dir, mode === "standalone" ? runAlone : fusion);
        const result = await callTool(
          tool,
          { path, ...params, ...(mode === "command" ? { then_run: { command: "check" } } : {}) },
          { ctx: { ...context, executeTool } },
        );
        assert.equal(reportOf(result, tool.name)?.publication, "NOT_PUBLISHED");
        assert.match(
          reportOf(result, tool.name)?.next ?? "",
          /file already has this content.*do not repeat/i,
        );
        assert.ok(result.details);
        assert.equal(Reflect.get(result.details, "diff"), tool.name === "write" ? undefined : "");
        assert.equal(reportOf(result, tool.name)?.freshness, undefined);
        assert.doesNotMatch(text(result), /Updated anchors|\d+#[0-9A-Z]+│/);
        assert.equal(commands, mode === "command" ? 1 : 0);
        assert.equal(
          reportOf(result, tool.name)?.then_run?.status,
          mode === "command" ? "succeeded" : undefined,
        );
        const after = await stat(path);
        assert.deepEqual(
          [after.ino, after.mtimeMs, after.ctimeMs],
          [before.ino, before.mtimeMs, before.ctimeMs],
        );
        assert.equal(await readFile(path, "utf8"), "same\n");
      }
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("delete and append change only line endings → publishes with an empty diff and still checks Fusion freshness", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "hashline-empty-diff-"));
  try {
    const context = await ctx(dir, t);
    for (const mode of ["standalone", "fusion", "command", "stale"] as const) {
      const path = join(dir, `${mode}.txt`);
      await writeFile(path, "same\r\nsame\n");
      let commands = 0;
      const executeTool: SessionCommand = async () => {
        commands++;
        assert.equal(await readFile(path, "utf8"), "same\nsame\r\n");
        return commandCompletion({ content: [] });
      };
      const fusion = createActionFusionScheduler((progress) => {
        if (mode === "stale" && progress.mutationCompleted && progress.command === "waiting")
          writeFileSync(path, "external\n");
      });
      const result = await callTool(
        makeEditOverride(dir, DEFAULT_CONFIG, mode === "standalone" ? runAlone : fusion),
        {
          path,
          steps: [
            {
              action: "delete",
              anchor: `1#${computeLineHash(1, "same", DEFAULT_CONFIG.hashLen)}`,
            },
            { action: "append", lines: ["same"] },
          ],
          ...(["command", "stale"].includes(mode) ? { then_run: { command: "check" } } : {}),
        },
        { ctx: { ...context, executeTool } },
      );
      const report = reportOf(result, "edit");
      assert.equal(result.isError, undefined);
      assert.equal(Reflect.get(result.details, "diff"), "");
      assert.equal(report?.publication, "PUBLISHED");
      assert.equal(report?.freshness, mode === "stale" ? "changed" : undefined);
      assert.equal(
        report?.then_run?.status,
        mode === "command" ? "succeeded" : mode === "stale" ? "skipped" : undefined,
      );
      if (mode === "stale") assert.match(report?.next ?? "", /Read the file before further edits/);
      else assert.equal(report?.next, undefined);
      assert.equal(commands, mode === "command" ? 1 : 0);
      assert.equal(
        await readFile(path, "utf8"),
        mode === "stale" ? "external\n" : "same\nsame\r\n",
      );
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("no-op Fusion still detects external changes and reports command failures", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "hashline-noop-fusion-"));
  try {
    const context = await ctx(dir, t);
    for (const { makeTool, params } of noOpCases) {
      for (const scenario of ["before", "during", "failed"]) {
        const path = join(dir, "same.txt");
        await writeFile(path, "same\n");
        let commands = 0;
        const executeTool: SessionCommand = async () => {
          commands++;
          if (scenario === "failed")
            return commandCompletion({ content: [{ type: "text", text: "check failed" }] }, true);
          await writeFile(path, "external\n");
          return commandCompletion({ content: [{ type: "text", text: "done" }] });
        };
        const fusion = createActionFusionScheduler((progress) => {
          if (scenario === "before" && progress.mutationCompleted && progress.command === "waiting")
            writeFileSync(path, "external\n");
        });
        const tool = makeTool(dir, fusion);
        const result = await callTool(
          tool,
          { path, ...params, then_run: { command: "check" } },
          { ctx: { ...context, executeTool } },
        );
        assert.equal(reportOf(result, tool.name)?.publication, "NOT_PUBLISHED");
        assert.equal(commands, scenario === "before" ? 0 : 1);
        assert.equal(
          reportOf(result, tool.name)?.then_run?.status,
          scenario === "before" ? "skipped" : scenario === "failed" ? "failed" : "succeeded",
        );
        assert.equal(
          reportOf(result, tool.name)?.freshness,
          scenario === "failed" ? undefined : "changed",
        );
        if (scenario === "failed")
          assert.match(
            reportOf(result, tool.name)?.next ?? "",
            /file already has this content.*do not repeat/i,
          );
        else
          assert.match(
            reportOf(result, tool.name)?.next ?? "",
            /Read the file before further edits/,
          );
      }
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
