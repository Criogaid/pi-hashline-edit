import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_CONFIG, loadConfig } from "./config.ts";

async function withSettings(
  fn: (
    write: (settings: unknown) => Promise<void>,
    root: string,
    agentDir: string,
  ) => Promise<void>,
) {
  const root = await mkdtemp(join(tmpdir(), "hashline-config-"));
  const agentDir = join(root, "agent");
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  try {
    process.env.PI_CODING_AGENT_DIR = agentDir;
    await mkdir(agentDir);
    await mkdir(join(root, ".pi"));
    const path = join(root, ".pi", "settings.json");
    await fn((settings) => writeFile(path, JSON.stringify(settings)), root, agentDir);
  } finally {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    await rm(root, { recursive: true, force: true });
  }
}

test("defaults come from the settings schema", () => {
  assert.deepEqual(DEFAULT_CONFIG, {
    enabled: true,
    actionFusion: true,
    forget: false,
    hashLen: 4,
    shiftRadius: 15,
    read: { defaultLimit: 500, maxKiB: 256 },
    grep: { defaultLimit: 100, defaultContext: 0 },
    replace: { regexTimeoutMs: 5_000 },
  });
});

test("actionFusion defaults on and honors explicit disabling", () =>
  withSettings(async (write, root) => {
    for (const [actionFusion, expected] of [
      [undefined, true],
      [false, false],
      [true, true],
      [null, true],
      ["false", true],
      [0, true],
    ]) {
      await write({ hashlineEdit: { actionFusion } });
      assert.deepEqual(loadConfig(root), { ...DEFAULT_CONFIG, actionFusion: expected });
    }
  }));

test("config rejects fractional values and tolerates malformed settings shapes", () =>
  withSettings(async (write, root) => {
    for (const value of [3.5, -1, "4", null]) {
      await write({ hashlineEdit: { hashLen: value, shiftRadius: value } });
      assert.deepEqual(loadConfig(root), DEFAULT_CONFIG);
    }
    for (const rootValue of [
      null,
      [],
      42,
      "settings",
      { hashlineEdit: [] },
      { hashlineEdit: "invalid" },
    ]) {
      await write(rootValue);
      assert.deepEqual(loadConfig(root), DEFAULT_CONFIG);
    }
    await write({ hashlineEdit: { hashLen: 8, shiftRadius: 0 } });
    assert.equal(loadConfig(root).hashLen, 8);
    assert.equal(loadConfig(root).shiftRadius, 0);
  }));

test("tool groups resolve each setting independently", () =>
  withSettings(async (write, root) => {
    await write({
      hashlineEdit: {
        read: { defaultLimit: 50, maxKiB: 0 },
        grep: { defaultContext: 21, defaultLimit: 7 },
        replace: "fast",
      },
    });
    assert.deepEqual(loadConfig(root), {
      ...DEFAULT_CONFIG,
      read: { defaultLimit: 50, maxKiB: DEFAULT_CONFIG.read.maxKiB },
      grep: { defaultLimit: 7, defaultContext: DEFAULT_CONFIG.grep.defaultContext },
    });
    await write({ hashlineEdit: { replace: { regexTimeoutMs: 20_000 } } });
    assert.equal(loadConfig(root).replace.regexTimeoutMs, 20_000);
  }));

test("project settings replace global groups while absent project settings use global values", () =>
  withSettings(async (write, root, agentDir) => {
    const globalConfig = {
      ...DEFAULT_CONFIG,
      enabled: false,
      actionFusion: false,
      hashLen: 8,
      shiftRadius: 0,
      read: { defaultLimit: 7, maxKiB: 2 },
      grep: { defaultLimit: 3, defaultContext: 2 },
      replace: { regexTimeoutMs: 1_000 },
    };
    await writeFile(
      join(agentDir, "settings.json"),
      JSON.stringify({ hashlineEdit: globalConfig }),
    );
    assert.deepEqual(loadConfig(), globalConfig);
    assert.deepEqual(loadConfig(root), globalConfig);
    for (const settings of [{}, null, [], 42, "settings"]) {
      await write(settings);
      assert.deepEqual(loadConfig(root), globalConfig);
    }
    await write({ hashlineEdit: { read: { defaultLimit: 2 } } });
    assert.deepEqual(loadConfig(root), {
      ...DEFAULT_CONFIG,
      read: { defaultLimit: 2, maxKiB: DEFAULT_CONFIG.read.maxKiB },
    });
    await write({ hashlineEdit: {} });
    assert.deepEqual(loadConfig(root), DEFAULT_CONFIG);
  }));

test("invalid tool groups default independently without discarding valid sibling groups", () =>
  withSettings(async (write, root) => {
    const configured = {
      ...DEFAULT_CONFIG,
      enabled: false,
      hashLen: 6,
      shiftRadius: 0,
      read: { defaultLimit: 2, maxKiB: 1 },
      grep: { defaultLimit: 3, defaultContext: 2 },
      replace: { regexTimeoutMs: 1_000 },
    };
    for (const group of ["read", "grep", "replace"] as const) {
      for (const value of [null, [], 42, "invalid", true]) {
        await write({ hashlineEdit: { ...configured, [group]: value } });
        assert.deepEqual(loadConfig(root), { ...configured, [group]: DEFAULT_CONFIG[group] });
      }
    }
  }));

test("tool settings accept their boundary values and default invalid leaves", () =>
  withSettings(async (write, root) => {
    const cases = [
      {
        group: "read",
        key: "defaultLimit",
        valid: [1, Number.MAX_SAFE_INTEGER],
        invalid: [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, "2", null],
      },
      { group: "read", key: "maxKiB", valid: [1, 4096], invalid: [0, 4097, 1.5, "2", null] },
      {
        group: "grep",
        key: "defaultLimit",
        valid: [1, Number.MAX_SAFE_INTEGER],
        invalid: [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, "2", null],
      },
      { group: "grep", key: "defaultContext", valid: [0, 20], invalid: [-1, 21, 1.5, "2", null] },
      {
        group: "replace",
        key: "regexTimeoutMs",
        valid: [1_000, 300_000],
        invalid: [999, 300_001, 1000.5, "1000", null],
      },
    ] as const;
    for (const { group, key, valid, invalid } of cases) {
      for (const value of valid) {
        await write({ hashlineEdit: { [group]: { [key]: value } } });
        assert.deepEqual(loadConfig(root), {
          ...DEFAULT_CONFIG,
          [group]: { ...DEFAULT_CONFIG[group], [key]: value },
        });
      }
      for (const value of invalid) {
        await write({ hashlineEdit: { [group]: { [key]: value } } });
        assert.deepEqual(loadConfig(root), DEFAULT_CONFIG);
      }
    }
  }));
