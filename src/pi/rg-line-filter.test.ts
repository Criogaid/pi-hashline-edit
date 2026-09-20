import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveIgnoreCase, type RunText } from "./rg-line-filter.ts";

test("explicit case settings skip the smart-case probe", async () => {
  const run: RunText = async () => {
    throw new Error("probe must not run");
  };
  assert.equal(await resolveIgnoreCase("rg", ["foo"], false, true, undefined, run), true);
  assert.equal(await resolveIgnoreCase("rg", ["foo"], false, false, undefined, run), false);
});

test("smart-case probe distinguishes its sensor from user matches", async () => {
  const calls: { args: readonly string[]; input: Buffer }[] = [];
  const insensitive: RunText = async (_path, args, input) => {
    calls.push({ args, input });
    return { code: 0, stdout: "a\n\n", stderr: "" };
  };
  assert.equal(await resolveIgnoreCase("rg", ["(a)|Foo"], false, undefined, undefined, insensitive), true);
  assert.deepEqual(calls[0].input, Buffer.from("a\n"));
  assert.ok(calls[0].args.includes("--smart-case"));
  assert.ok(calls[0].args.includes("--no-config"));

  const sensitive: RunText = async () => ({ code: 0, stdout: "\n", stderr: "" });
  assert.equal(await resolveIgnoreCase("rg", ["(a)|Foo"], false, undefined, undefined, sensitive), false);
});

test("literal smart-case escapes user patterns before probing", async () => {
  let args: readonly string[] = [];
  const run: RunText = async (_path, received) => {
    args = received;
    return { code: 1, stdout: "", stderr: "" };
  };
  await resolveIgnoreCase("rg", ["foo\\S*"], true, undefined, undefined, run);
  const patterns = args.flatMap((arg, index) => args[index - 1] === "-e" ? [arg] : []);
  assert.deepEqual(patterns, ["(\\p{Lu})", "foo\\\\S\\*"]);
});

test("smart-case probe propagates parser errors and rejects unknown output", async () => {
  const failed: RunText = async () => ({ code: 2, stdout: "", stderr: "regex parse error" });
  await assert.rejects(
    resolveIgnoreCase("rg", ["("], false, undefined, undefined, failed),
    /regex parse error/,
  );

  const unexpected: RunText = async () => ({ code: 0, stdout: "unexpected\n", stderr: "" });
  await assert.rejects(
    resolveIgnoreCase("rg", ["foo"], false, undefined, undefined, unexpected),
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
    resolveIgnoreCase("rg", ["foo"], false, undefined, controller.signal, run),
    /Operation aborted/,
  );
});
