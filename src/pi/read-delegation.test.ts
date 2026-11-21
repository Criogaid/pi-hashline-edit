import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import * as pi from "@earendil-works/pi-coding-agent";
import { callTool } from "./tool-call.testing.ts";
import { loadConfig } from "./config.ts";
import { outputBudgetsFor } from "./budgets.ts";
import { reportOf } from "./report.ts";

test("read delegation → only images and NUL use native read on the canonical target", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "hashline-read-delegation-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  type Native = ReturnType<typeof pi.createReadToolDefinition>;
  let beforeNative: (() => Promise<void>) | undefined;
  const execute = t.mock.fn(async (native: Native, ...args: Parameters<Native["execute"]>) => {
    await beforeNative?.();
    return native.execute(...args);
  });
  t.mock.module("@earendil-works/pi-coding-agent", {
    namedExports: {
      ...pi,
      createReadToolDefinition: (...args: Parameters<typeof pi.createReadToolDefinition>) => {
        const native = pi.createReadToolDefinition(...args);
        return {
          ...native,
          execute: (...args: Parameters<Native["execute"]>) => execute(native, ...args),
        };
      },
    },
  });
  const { makeReadOverride } = await import("./read-tool.ts");
  const tool = makeReadOverride({
    cwd: dir,
    config: loadConfig(dir),
    budgets: () => outputBudgetsFor(undefined),
  });
  const image = Buffer.from("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7", "base64");
  await writeFile(join(dir, "image.gif"), image);
  await writeFile(join(dir, "nul.txt"), "first\0\nsecond\n");
  await writeFile(join(dir, "invalid.txt"), Buffer.from([0xff]));
  await mkdir(join(dir, "directory"));
  for (const [path, error, native] of [
    ["image.gif", undefined, true],
    ["nul.txt", undefined, true],
    ["missing.txt", "PATH_NOT_FOUND", false],
    ["directory", "NOT_REGULAR_FILE", false],
    ["nul.txt/child", process.platform === "win32" ? "PATH_NOT_FOUND" : "FILESYSTEM_ERROR", false],
    ["invalid.txt", "UNSUPPORTED_ENCODING", false],
  ] as const) {
    await t.test(path, async () => {
      const before = execute.mock.callCount();
      const params = { path, offset: 1, limit: 1 };
      const result = await callTool(tool, { ...params, anchors: false });
      assert.equal(execute.mock.callCount(), before + Number(native));
      assert.equal(result.isError === true, error !== undefined);
      assert.equal(reportOf(result, "read")?.error, error);
      if (native) {
        assert.deepEqual(execute.mock.calls.at(-1)?.arguments[2], {
          ...params,
          path: join(dir, path),
        });
        assert.equal(result.details?.nativeRead, true);
      }
    });
  }

  await t.test("NUL read delegation → native read receives the original signal", async (t) => {
    for (const [name, signal] of [
      ["undefined signal", undefined],
      ["provided signal", new AbortController().signal],
    ] as const) {
      await t.test(name, async () => {
        const before = execute.mock.callCount();
        const result = await callTool(tool, { path: "nul.txt" }, { signal });
        assert.equal(result.details?.nativeRead, true);
        assert.equal(execute.mock.callCount(), before + 1);
        assert.equal(execute.mock.calls.at(-1)?.arguments[3], signal);
      });
    }
  });

  await t.test(
    "encoded Unicode path and different context cwd → delegates the exact file",
    async () => {
      const other = join(dir, "other");
      await mkdir(other);
      for (const [name, bytes] of [
        ["image\u202f.gif", image],
        ["nul\u202f.txt", Buffer.from("exact\0target")],
      ] as const) {
        await writeFile(join(dir, name), bytes);
        await writeFile(join(dir, name.replace("\u202f", " ")), "wrong normalized target");
        const result = await callTool(
          tool,
          { path: pathToFileURL(join(dir, name)).href },
          { ctx: { cwd: other } },
        );
        assert.equal(result.isError, undefined);
        assert.equal(result.details?.nativeRead, true);
        if (name.endsWith(".gif"))
          assert.ok(result.content.some((block) => block.type === "image"));
        else
          assert.equal(
            result.content[0]?.type === "text" && result.content[0].text,
            bytes.toString(),
          );
      }
      const result = await callTool(tool, { path: "@nul.txt" }, { ctx: { cwd: other } });
      assert.equal(result.isError, undefined);
      assert.equal(
        result.content[0]?.type === "text" && result.content[0].text,
        "first\0\nsecond\n",
      );
    },
  );

  await t.test(
    "canonical target disappears before native read → does not open a filename variant",
    async () => {
      const target = join(dir, "shot 9 AM.txt");
      await writeFile(target, "original\0target");
      await writeFile(join(dir, "shot 9\u202fAM.txt"), "wrong variant");
      beforeNative = () => rm(target);
      const result = await callTool(tool, { path: "shot 9 AM.txt" });
      beforeNative = undefined;
      assert.equal(result.isError, true);
      assert.equal(reportOf(result, "read")?.error, "PATH_NOT_FOUND");
      assert.deepEqual(reportOf(result, "read")?.missing, [target.replaceAll("\\", "/")]);
    },
  );
});
