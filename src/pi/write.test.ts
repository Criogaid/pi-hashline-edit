import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { test } from "node:test";
import { makeWriteOverride } from "./write-tool.ts";
import { createActionFusionExecutor, THEN_RUN_STALE, THEN_RUN_SUCCEEDED } from "./action-fusion.ts";
import { fileRevision } from "./file-commit.ts";
import { callTool } from "./tool-call.testing.ts";
import { staleTargetNotice } from "./mutation-result.ts";

const context = (cwd: string) => ({ cwd }) as any;

async function withTemp<T>(run: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "hashline-write-"));
  try {
    return await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("write schema follows the shared actionFusion switch", () => {
  const plain = makeWriteOverride("/tmp");
  assert.equal(Object.hasOwn(plain.parameters.properties, "then_run"), false);
  assert.equal(Object.hasOwn(plain.parameters.properties, "expectedRevision"), false);
  const fusion = createActionFusionExecutor();
  const withFusion = makeWriteOverride("/tmp", fusion);
  assert.equal(Object.hasOwn(withFusion.parameters.properties, "then_run"), true);
  assert.equal(Object.hasOwn(withFusion.parameters.properties, "expectedRevision"), false);
});

test("write rejects unknown fields rather than ignoring a misspelled create mode", async () =>
  withTemp(async (dir) => {
    const file = join(dir, "file.txt");
    await writeFile(file, "original\n");
    for (const fusion of [undefined, createActionFusionExecutor()]) {
      const tool = makeWriteOverride(dir, fusion);
      const args = { path: "file.txt", content: "new\n", modee: "create" };
      await assert.rejects(
        callTool(tool, args, { ctx: context(dir) }),
        /Validation failed for tool "write":[\s\S]*- modee: is not allowed/,
      );
      assert.equal(await readFile(file, "utf8"), "original\n");
    }
  }));

test("write rejects unwritable content before accessing a missing target", async () =>
  withTemp(async (dir) => {
    const file = join(dir, "missing.txt");
    const tool = makeWriteOverride(dir);
    const valid = { path: file, content: "ready\n", mode: "create" };
    assert.equal(tool.prepareArguments(valid), valid);
    for (const [content, expected] of [
      ["bad\0", /Invalid argument content: UNSUPPORTED_TEXT: NUL bytes are not editable\./],
      ["\ud800", /Invalid argument content: INVALID_UNICODE:/],
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
    const fusion = createActionFusionExecutor(async () => {
      commandRuns++;
      return { status: "succeeded", output: "checked" };
    });
    for (const executor of [undefined, fusion]) {
      const tool = makeWriteOverride(dir, executor);
      for (const path of [existing, missing]) {
        await assert.rejects(
          callTool(
            tool,
            { path, content: "changed\n", ...(executor ? { then_run: { command: "check" } } : {}) },
            { ctx: context(dir) },
          ),
          /\n {2}- mode:/,
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
    assert.doesNotMatch(created.content[0].text, /Revision:|[0-9a-f]{64}/);
    assert.equal(created.details.publishedRevision, await fileRevision(target));
    assert.equal("revision" in created.details, false);
    await assert.rejects(
      callTool(write, { path: "new.txt", content: "bad\n", mode: "create" }, options),
      /already exists/,
    );
    assert.equal(await readFile(target, "utf8"), "new\n");
    await assert.rejects(
      callTool(write, { path: "missing.txt", content: "bad\n", mode: "overwrite" }, options),
      /does not exist/,
    );
    await callTool(write, { path: "new.txt", content: "updated\n", mode: "overwrite" }, options);
    assert.equal(await readFile(target, "utf8"), "updated\n");
  }));

test("write rejects obsolete expectedRevision without overwriting", async () =>
  withTemp(async (dir) => {
    const target = join(dir, "concurrent.txt");
    await writeFile(target, "original\n");
    const params = {
      path: target,
      content: "changed\n",
      mode: "overwrite",
      expectedRevision: await fileRevision(target),
    };
    for (const fusion of [undefined, createActionFusionExecutor()]) {
      const write = makeWriteOverride(dir, fusion);
      await assert.rejects(
        callTool(write, params, { ctx: context(dir) }),
        /Validation failed for tool "write":\n {2}- expectedRevision: is not allowed/,
      );
      assert.equal(await readFile(target, "utf8"), "original\n");
    }
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
      assert.deepEqual(result.content, [{ type: "text", text: `Created ${path}.` }]);
      assert.equal(await readFile(join(dir, path), "utf8"), content);
    }
  }));

test("write returns its summary and command output after an unchanged then_run", async () =>
  withTemp(async (dir) => {
    const fusion = createActionFusionExecutor(async () => ({
      status: "succeeded",
      output: "checked",
    }));
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
      context(dir),
    );
    assert.deepEqual(result.content, [
      { type: "text", text: "Created unchanged.txt." },
      { type: "text", text: "[then_run:succeeded]\nchecked" },
    ]);
    assert.equal(result.details.actionFusion.freshness, "unchanged");
  }));

test("write reports changed freshness when then_run changes the target", async () =>
  withTemp(async (dir) => {
    const target = join(dir, "changed.txt");
    const fusion = createActionFusionExecutor(async () => {
      await writeFile(target, "command changed\n");
      return { status: "succeeded", output: "checked" };
    });
    const write = makeWriteOverride(dir, fusion) as any;
    const result = await callTool(
      write,
      {
        path: "changed.txt",
        content: "mutation\n",
        mode: "create",
        then_run: { command: "check" },
      },
      { toolCallId: "changed", ctx: context(dir) },
    );
    const text = result.content.map((block: any) => block.text).join("\n");
    assert.doesNotMatch(text, /revision:|[0-9a-f]{64}/i);
    assert.deepEqual(result.content, [
      { type: "text", text: "Created changed.txt." },
      { type: "text", text: staleTargetNotice(THEN_RUN_STALE) },
      { type: "text", text: `${THEN_RUN_SUCCEEDED}\nchecked` },
    ]);
    assert.doesNotMatch(text, /Fresh anchors:|\b1#[0-9A-Z]+\b/);
    assert.equal(result.details.actionFusion.freshness, "changed");
    assert.deepEqual(
      write.renderResult(result, { isPartial: false }, {}, { isError: false }).render(100),
      [],
    );
  }));

test("write reports missing freshness when then_run removes the target", async () =>
  withTemp(async (dir) => {
    const target = join(dir, "missing.txt");
    const fusion = createActionFusionExecutor(async () => {
      await rm(target);
      return { status: "succeeded", output: "removed" };
    });
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
      context(dir),
    );
    const text = result.content.map((block: any) => block.text).join("\n");
    assert.ok(result.details.actionFusion);
    assert.equal(result.details.actionFusion.freshness, "missing");
    assert.match(text, /Re-read/);
    assert.doesNotMatch(text, /Fresh anchors:/);
  }));

test("write preserves command failure and changed freshness", async () =>
  withTemp(async (dir) => {
    const target = join(dir, "failed.txt");
    const fusion = createActionFusionExecutor(async () => {
      await writeFile(target, "changed before failure\n");
      throw new Error("command failed");
    });
    const result = await makeWriteOverride(dir, fusion).execute(
      "failed",
      { path: "failed.txt", content: "mutation\n", mode: "create", then_run: { command: "fail" } },
      undefined,
      undefined,
      context(dir),
    );
    const text = result.content.map((block: any) => block.text).join("\n");
    assert.ok(result.details.actionFusion);
    assert.equal(result.details.actionFusion.freshness, "changed");
    assert.equal(result.details.actionFusion.command, "failed");
    assert.match(text, /Re-read/);
    assert.doesNotMatch(text, /Fresh anchors:/);
  }));

test("write rejects NUL content", async () =>
  withTemp(async (dir) => {
    const write = makeWriteOverride(dir);
    await assert.rejects(
      write.execute(
        "nul",
        { path: "nul.txt", content: "a\0b", mode: "create" },
        undefined,
        undefined,
        context(dir),
      ),
      /UNSUPPORTED_TEXT/,
    );
    await assert.rejects(readFile(join(dir, "nul.txt")), /ENOENT/);
  }));
