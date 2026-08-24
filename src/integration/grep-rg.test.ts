/**
 * Explicit real-ripgrep integration coverage. This is excluded from the default
 * test script and never delegates to Pi's built-in grep/download path.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { access, constants, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { makeGrepOverrideWithBackend } from "../pi/grep-tool.ts";

async function findPathRg(): Promise<string | null> {
  for (const directory of process.env.PATH?.split(delimiter) ?? []) {
    if (!directory) continue;
    const candidate = join(directory, "rg");
    try {
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {}
  }
  return null;
}

const rgPath = await findPathRg();

test("real rg emits anchored matches from a temporary directory", {
  skip: rgPath === null,
}, async () => {
  const directory = await mkdtemp(join(tmpdir(), "hl-grep-integration-"));
  try {
    const file = join(directory, "fixture.ts");
    await writeFile(file, "needle\nother\n");
    const tool = makeGrepOverrideWithBackend(directory, {
      findRg: async () => rgPath,
      delegate: async () => {
        throw new Error("integration test must not invoke the built-in grep delegate");
      },
    });

    const result: any = await tool.execute("0", { pattern: "needle" }, undefined, undefined);
    assert.match(result.content[0].text, /fixture\.ts · 1 match/);
    assert.match(result.content[0].text, /1#[0-9A-Z]+│needle/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
