import { test } from "node:test";
import assert from "node:assert/strict";
import { assertRgSucceeded, resolveIgnoreCase, type RunText } from "./rg-line-filter.ts";

const lineModes = { literal: false, multiline: false } as const;

test("explicit case settings bypass the smart-case probe", async () => {
  const run: RunText = async () => {
    throw new Error("probe must not run");
  };
  const modes = { literal: false, multiline: true } as const;
  assert.equal(await resolveIgnoreCase("rg", ["Foo"], modes, true, undefined, run), true);
  assert.equal(await resolveIgnoreCase("rg", ["foo"], modes, false, undefined, run), false);
});

test("standard smart-case probe distinguishes its sensor from user matches", async () => {
  const calls: { args: readonly string[]; input: Buffer }[] = [];
  const insensitive: RunText = async (_path, args, input) => {
    calls.push({ args, input });
    return { code: 0, stdout: "a\n\n", stderr: "" };
  };
  assert.equal(
    await resolveIgnoreCase("rg", ["(a)|Foo"], lineModes, undefined, undefined, insensitive),
    true,
  );
  assert.deepEqual(calls[0].input, Buffer.from("a\n"));
  assert.ok(calls[0].args.includes("--smart-case"));
  assert.ok(calls[0].args.includes("--no-config"));
  assert.ok(calls[0].args.includes("--no-multiline"));

  const sensitive: RunText = async () => ({ code: 0, stdout: "\n", stderr: "" });
  assert.equal(
    await resolveIgnoreCase("rg", ["(a)|Foo"], lineModes, undefined, undefined, sensitive),
    false,
  );
});

test("literal smart-case escapes user patterns before probing", async () => {
  let args: readonly string[] = [];
  const run: RunText = async (_path, received) => {
    args = received;
    return { code: 1, stdout: "", stderr: "" };
  };
  await resolveIgnoreCase(
    "rg",
    ["foo\\S*"],
    { ...lineModes, literal: true },
    undefined,
    undefined,
    run,
  );
  const patterns = args.flatMap((arg, index) => (args[index - 1] === "-e" ? [arg] : []));
  assert.deepEqual(patterns, ["(\\p{Lu})", "foo\\\\S\\*"]);
});

test("multiline smart-case probe uses the same mode as matching", async () => {
  let args: readonly string[] = [];
  const run: RunText = async (_path, received) => {
    args = received;
    return { code: 0, stdout: "a\n\n", stderr: "" };
  };
  assert.equal(
    await resolveIgnoreCase(
      "rg",
      ["foo\\nbar"],
      { literal: false, multiline: true },
      undefined,
      undefined,
      run,
    ),
    true,
  );
  assert.ok(args.includes("--multiline"));
  assert.ok(!args.includes("--no-multiline"));
});

test("smart-case probe propagates parser errors and rejects unknown output", async () => {
  const failed: RunText = async () => ({ code: 2, stdout: "", stderr: "regex parse error" });
  await assert.rejects(
    resolveIgnoreCase("rg", ["("], lineModes, undefined, undefined, failed),
    /regex parse error/,
  );

  const unexpected: RunText = async () => ({ code: 0, stdout: "unexpected\n", stderr: "" });
  await assert.rejects(
    resolveIgnoreCase("rg", ["foo"], lineModes, undefined, undefined, unexpected),
    /Unexpected smart-case probe output/,
  );
});

test("smart-case probe normalizes cancellation without fallback", async () => {
  const controller = new AbortController();
  const run: RunText = async () => {
    controller.abort();
    return { code: 1, stdout: "", stderr: "" };
  };
  await assert.rejects(
    resolveIgnoreCase("rg", ["foo"], lineModes, undefined, controller.signal, run),
    /Operation aborted/,
  );
});

test("search exit status accepts no matches and preserves failure diagnostics", () => {
  for (const code of [0, 1]) assert.doesNotThrow(() => assertRgSucceeded({ code, stderr: "" }));
  assert.throws(
    () => assertRgSucceeded({ code: 2, stderr: "  regex parse error\n" }),
    /^Error: regex parse error$/,
  );
  assert.throws(
    () => assertRgSucceeded({ code: null, stderr: "" }),
    /ripgrep exited with code null/,
  );
});
