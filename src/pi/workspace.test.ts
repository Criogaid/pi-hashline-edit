import assert from "node:assert/strict";
import { basename, resolve } from "node:path";
import { test } from "node:test";
import type { ExecResult } from "@earendil-works/pi-coding-agent";
import { resolveWorkspace } from "./workspace.ts";

test("Windows script host fails or returns an invalid path → PowerShell resolves the workspace", {
  skip: process.platform !== "win32",
}, async (t) => {
  const cwd = resolve("workspace % 目录");
  const result = { stdout: cwd, stderr: "", code: 0, killed: false, truncated: false };
  const failures = {
    "host unavailable": { ...result, code: 1, stdout: "" },
    "malformed escape": { ...result, stdout: "C%3A%5C%XY" },
    "relative path": { ...result, stdout: "workspace" },
  } satisfies Record<string, ExecResult>;
  for (const [name, failure] of Object.entries(failures)) {
    await t.test(name, async () => {
      const commands: string[] = [];
      const actual = await resolveWorkspace({
        async exec(command) {
          commands.push(basename(command));
          return commands.length === 1 ? failure : result;
        },
      });
      assert.equal(actual, cwd);
      assert.deepEqual(commands, ["cscript.exe", "powershell.exe"]);
    });
  }
});
