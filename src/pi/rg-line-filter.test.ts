import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveIgnoreCase, type RunText } from "./rg-line-filter.ts";

const regexMode = { engine: "default", multiline: false, literal: false } as const;
const literalMode = { ...regexMode, literal: true } as const;

test("explicit case settings skip the smart-case probe", async () => {
  const run: RunText = async () => { throw new Error("probe must not run"); };
  assert.equal(await resolveIgnoreCase("rg", ["foo"], regexMode, true, undefined, run), true);
  assert.equal(await resolveIgnoreCase("rg", ["foo"], regexMode, false, undefined, run), false);
});

test("standard smart-case probe distinguishes its sensor from user matches", async () => {
  const calls: { args: readonly string[]; input: Buffer }[] = [];
  const insensitive: RunText = async (_path, args, input) => {
    calls.push({ args, input });
    return { code: 0, stdout: "a\n\n", stderr: "" };
  };
  assert.equal(await resolveIgnoreCase("rg", ["(a)|Foo"], regexMode, undefined, undefined, insensitive), true);
  assert.deepEqual(calls[0].input, Buffer.from("a\n"));
  assert.ok(calls[0].args.includes("--smart-case"));
  assert.ok(calls[0].args.includes("--no-config"));

  const sensitive: RunText = async () => ({ code: 0, stdout: "\n", stderr: "" });
  assert.equal(await resolveIgnoreCase("rg", ["(a)|Foo"], regexMode, undefined, undefined, sensitive), false);
});

test("literal smart-case escapes user patterns before probing", async () => {
  let args: readonly string[] = [];
  const run: RunText = async (_path, received) => {
    args = received;
    return { code: 1, stdout: "", stderr: "" };
  };
  await resolveIgnoreCase("rg", ["foo\\S*"], literalMode, undefined, undefined, run);
  const patterns = args.flatMap((arg, index) => args[index - 1] === "-e" ? [arg] : []);
  assert.deepEqual(patterns, ["(\\p{Lu})", "foo\\\\S\\*"]);
});

test("PCRE2 smart-case uses a version-gated comment carrier", async () => {
  const calls: { args: readonly string[]; input: Buffer }[] = [];
  const run: RunText = async (_path, args, input) => {
    calls.push({ args, input });
    if (args.includes("--version")) {
      return { code: 0, stdout: "ripgrep 15.0.0\nfeatures:+pcre2\nPCRE2 10.45 is available (JIT is available)\n", stderr: "" };
    }
    return { code: 0, stdout: "", stderr: "" };
  };
  const mode = { engine: "pcre2", multiline: true, literal: false } as const;
  assert.equal(await resolveIgnoreCase("rg", ["foo(?=bar)", "Foo\nbar"], mode, undefined, undefined, run), true);
  const carrier = calls[1].args[calls[1].args.indexOf("-e") + 1];
  assert.equal(carrier, "(?x)\n#foo(?=bar)\n#Foo\n#bar\n\\x{41}\n");
  assert.ok(calls[1].args.includes("--engine=pcre2"));
  assert.ok(calls[1].args.includes("--multiline"));
});

test("PCRE2 smart-case rejects unvalidated builds unless case is explicit", async () => {
  const run: RunText = async () => ({ code: 0, stdout: "ripgrep 16.0.0\nfeatures:+pcre2\n", stderr: "" });
  const mode = { engine: "pcre2", multiline: false, literal: false } as const;
  await assert.rejects(resolveIgnoreCase("rg", ["foo"], mode, undefined, undefined, run), /not validated/);
  assert.equal(await resolveIgnoreCase("rg", ["foo"], mode, false, undefined, run), false);
});

test("smart-case probe propagates parser errors and rejects unknown output", async () => {
  const failed: RunText = async () => ({ code: 2, stdout: "", stderr: "regex parse error" });
  await assert.rejects(resolveIgnoreCase("rg", ["("], regexMode, undefined, undefined, failed), /regex parse error/);

  const unexpected: RunText = async () => ({ code: 0, stdout: "unexpected\n", stderr: "" });
  await assert.rejects(resolveIgnoreCase("rg", ["foo"], regexMode, undefined, undefined, unexpected), /Unexpected smart-case probe output/);
});

test("smart-case probe normalizes cancellation without fallback", async () => {
  const controller = new AbortController();
  const run: RunText = async () => {
    controller.abort();
    return { code: 1, stdout: "", stderr: "" };
  };
  await assert.rejects(resolveIgnoreCase("rg", ["foo"], regexMode, undefined, controller.signal, run), /Operation aborted/);
});
