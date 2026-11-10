import { commandCompletion, type SessionCommand } from "./action-fusion.testing.ts";
import { rejectsArgument } from "./argument-error.testing.ts";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { test } from "node:test";
import { makeWriteOverride } from "./tool-factories.testing.ts";
import { createActionFusionExecutor } from "./action-fusion.ts";
import { callTool } from "./tool-call.testing.ts";
import { reportOf } from "./report.ts";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { theme } from "../../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js";
initTheme("dark");

const context = (cwd: string) => ({ cwd }) as any;

async function withTemp<T>(run: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "hashline-write-"));
  try {
    return await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("write receives an unknown field → rejects without changing the file", async () =>
  withTemp(async (dir) => {
    const file = join(dir, "file.txt");
    await writeFile(file, "original\n");
    for (const fusion of [undefined, createActionFusionExecutor(() => {})]) {
      const tool = makeWriteOverride(dir, fusion);
      const args = { path: "file.txt", content: "new\n", mode: "overwrite", unexpected: true };
      await assert.rejects(
        callTool(tool, args, { ctx: context(dir) }),
        rejectsArgument("unexpected", /not allowed/),
      );
      assert.equal(await readFile(file, "utf8"), "original\n");
    }
  }));

test("write rejects unwritable content before accessing a missing target", async () =>
  withTemp(async (dir) => {
    const file = join(dir, "missing.txt");
    const tool = makeWriteOverride(dir);
    for (const [content, expected] of [
      ["bad\0", rejectsArgument("content", /NUL/)],
      ["\ud800", rejectsArgument("content", /encoded losslessly/)],
    ] as const) {
      await assert.rejects(
        callTool(tool, { path: file, content, mode: "create" }, { ctx: context(dir) }),
        expected,
      );
      await assert.rejects(readFile(file, "utf8"), { code: "ENOENT" });
    }
  }));

test("write omits mode → rejects before changing files or running commands", async () =>
  withTemp(async (dir) => {
    const existing = join(dir, "existing.txt");
    const missingParent = join(dir, "missing");
    const missing = join(missingParent, "new.txt");
    await writeFile(existing, "original\n");
    let commandRuns = 0;
    const executeTool: SessionCommand = async () => {
      commandRuns++;
      return commandCompletion({ content: [{ type: "text", text: "checked" }] });
    };
    const fusion = createActionFusionExecutor(() => {});
    for (const executor of [undefined, fusion]) {
      const tool = makeWriteOverride(dir, executor);
      for (const path of [existing, missing]) {
        await assert.rejects(
          callTool(
            tool,
            { path, content: "changed\n", ...(executor ? { then_run: { command: "check" } } : {}) },
            { ctx: { ...context(dir), executeTool } },
          ),
          rejectsArgument("mode", /required/),
        );
      }
    }
    assert.equal(await readFile(existing, "utf8"), "original\n");
    await assert.rejects(readFile(missingParent), { code: "ENOENT" });
    assert.equal(commandRuns, 0);
  }));

test("write supports create-only and overwrite-only modes", async () =>
  withTemp(async (dir) => {
    const write = makeWriteOverride(dir);
    const target = join(dir, "new.txt");
    const options = { ctx: context(dir) };
    const created = await callTool(
      write,
      { path: "new.txt", content: "new\n", mode: "create" },
      options,
    );
    assert.equal(created.content[0].type, "text");
    assert.doesNotMatch(created.content[0].text, /Revision:|[0-9a-f]{64}/);
    assert.deepEqual(await readFile(target), Buffer.from("new\n"));
    assert.equal(reportOf(created, "write")?.publication, "PUBLISHED");
    const exists = await callTool(
      write,
      { path: "new.txt", content: "bad\n", mode: "create" },
      options,
    );
    assert.equal(exists.isError, true);
    const conflict = reportOf(exists, "write");
    assert.equal(conflict?.error, "TARGET_EXISTS");
    assert.equal(conflict?.publication, "NOT_PUBLISHED");
    const next = conflict?.next ?? "";
    assert.match(next, /check the path/i);
    assert.match(next, /read the existing file/i);
    assert.match(next, /overwrite.*only if.*intended/i);
    assert.equal(await readFile(target, "utf8"), "new\n");
    const missing = await callTool(
      write,
      { path: "missing.txt", content: "bad\n", mode: "overwrite" },
      options,
    );
    assert.equal(missing.isError, true);
    assert.equal(reportOf(missing, "write")?.error, "PATH_NOT_FOUND");
    await callTool(write, { path: "new.txt", content: "updated\n", mode: "overwrite" }, options);
    assert.equal(await readFile(target, "utf8"), "updated\n");
  }));

test("write returns only a summary for empty, short, and long content", async () =>
  withTemp(async (dir) => {
    const contents = [
      "",
      "before\n",
      Array.from({ length: 500 }, (_, index) => `line ${index + 1}`).join("\n"),
    ];
    for (const [index, content] of contents.entries()) {
      const path = `file-${index}.txt`;
      const result = await makeWriteOverride(dir).execute(
        "write",
        { path, content, mode: "create" },
        undefined,
        undefined,
        context(dir),
      );
      assert.equal(reportOf(result, "write")?.path, path);
      assert.equal(reportOf(result, "write")?.publication, "PUBLISHED");
      assert.equal(result.content.length, 1);
      const block = result.content[0];
      assert.equal(block.type, "text");
      assert.deepEqual(JSON.parse(block.text), { publication: "PUBLISHED" });
      assert.equal(await readFile(join(dir, path), "utf8"), content);
    }
  }));

test("write returns its summary and command output after an unchanged then_run", async () =>
  withTemp(async (dir) => {
    const executeTool: SessionCommand = async () =>
      commandCompletion({ content: [{ type: "text", text: "checked" }] });
    const fusion = createActionFusionExecutor(() => {});
    const write = makeWriteOverride(dir, fusion) as any;
    const result = await write.execute(
      "unchanged",
      {
        path: "unchanged.txt",
        content: "mutation\n",
        mode: "create",
        then_run: { command: "check" },
      },
      undefined,
      undefined,
      { ...context(dir), executeTool },
    );
    assert.deepEqual(reportOf(result, "write")?.then_run, {
      status: "succeeded",
      output: "checked",
    });
  }));

test("write reports changed freshness when then_run changes the target", async () =>
  withTemp(async (dir) => {
    const target = join(dir, "changed.txt");
    const executeTool: SessionCommand = async () => {
      await writeFile(target, "command changed\n");
      return commandCompletion({ content: [{ type: "text", text: "checked" }] });
    };
    const fusion = createActionFusionExecutor(() => {});
    const write = makeWriteOverride(dir, fusion) as any;
    const result = await callTool(
      write,
      {
        path: "changed.txt",
        content: "mutation\n",
        mode: "create",
        then_run: { command: "check" },
      },
      { toolCallId: "changed", ctx: { ...context(dir), executeTool } },
    );
    const text = result.content.map((block: any) => block.text).join("\n");
    assert.doesNotMatch(text, /revision:|[0-9a-f]{64}/i);
    assert.equal(reportOf(result, "write")?.freshness, "changed");
    assert.match(reportOf(result, "write")?.next ?? "", /Read the file before further edits/);
    assert.deepEqual(reportOf(result, "write")?.then_run, {
      status: "succeeded",
      output: "checked",
    });
    assert.doesNotMatch(text, /\b1#[0-9A-Z]+\b/);
    const rendered = write
      .renderResult(result, { isPartial: false }, theme, { isError: false })
      .render(100)
      .join("\n");
    assert.match(rendered, /changed/);
    assert.match(rendered, /Read the file/);
    assert.doesNotMatch(rendered, /Command|checked/);
  }));

test("write reports missing freshness when then_run removes the target", async () =>
  withTemp(async (dir) => {
    const target = join(dir, "missing.txt");
    const executeTool: SessionCommand = async () => {
      await rm(target);
      return commandCompletion({ content: [{ type: "text", text: "removed" }] });
    };
    const fusion = createActionFusionExecutor(() => {});
    const result = await makeWriteOverride(dir, fusion).execute(
      "missing",
      {
        path: "missing.txt",
        content: "mutation\n",
        mode: "create",
        then_run: { command: "remove" },
      },
      undefined,
      undefined,
      { ...context(dir), executeTool },
    );
    assert.equal(reportOf(result, "write")?.freshness, "missing");
    assert.equal(reportOf(result, "write")?.next, undefined);
  }));

test("write preserves command failure and changed freshness", async () =>
  withTemp(async (dir) => {
    const target = join(dir, "failed.txt");
    const executeTool: SessionCommand = async () => {
      await writeFile(target, "changed before failure\n");
      return commandCompletion({ content: [{ type: "text", text: "command failed" }] }, true);
    };
    const fusion = createActionFusionExecutor(() => {});
    const result = await makeWriteOverride(dir, fusion).execute(
      "failed",
      { path: "failed.txt", content: "mutation\n", mode: "create", then_run: { command: "fail" } },
      undefined,
      undefined,
      { ...context(dir), executeTool },
    );
    assert.equal(reportOf(result, "write")?.freshness, "changed");
    assert.equal(reportOf(result, "write")?.then_run?.status, "failed");
    assert.match(reportOf(result, "write")?.next ?? "", /Read the file before further edits/);
  }));
