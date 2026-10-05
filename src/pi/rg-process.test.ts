import { test } from "node:test";
import assert from "node:assert/strict";
import { assertRgSucceeded, resolveIgnoreCase, type RunText } from "./rg-process.ts";

const lineModes = { literal: false, multiline: false } as const;

test("explicit case settings bypass the smart-case probe", async () => {
  const run: RunText = async () => {
    throw new Error("probe must not run");
  };
  const modes = { literal: false, multiline: true } as const;
  assert.equal(await resolveIgnoreCase("rg", ["Foo"], modes, true, undefined, run), true);
  assert.equal(await resolveIgnoreCase("rg", ["foo"], modes, false, undefined, run), false);
});

test("smart-case probes preserve modes and distinguish the sensor from user matches", async () => {
  for (const { patterns, modes, expectedPatterns } of [
    { patterns: ["(a)|Foo"], modes: lineModes, expectedPatterns: ["(\\p{Lu})", "(a)|Foo"] },
    {
      patterns: ["foo\\S*"],
      modes: { ...lineModes, literal: true },
      expectedPatterns: ["(\\p{Lu})", "foo\\\\S\\*"],
    },
    {
      patterns: ["foo\\nbar"],
      modes: { ...lineModes, multiline: true },
      expectedPatterns: ["(\\p{Lu})", "foo\\nbar"],
    },
  ]) {
    for (const [code, stdout, expected] of [
      [0, "a\n\n", true],
      [0, "\n", false],
      [1, "", false],
    ] as const) {
      let calls = 0;
      const run: RunText = async (_path, args, input) => {
        calls++;
        assert.deepEqual(input, Buffer.from("a\n"));
        assert.ok(args.includes("--smart-case"));
        assert.ok(args.includes("--no-config"));
        assert.equal(args.includes("--multiline"), modes.multiline);
        assert.equal(args.includes("--no-multiline"), !modes.multiline);
        assert.deepEqual(
          args.flatMap((arg, index) => (args[index - 1] === "-e" ? [arg] : [])),
          expectedPatterns,
        );
        return { code, stdout, stderr: "" };
      };
      assert.equal(
        await resolveIgnoreCase("rg", patterns, modes, undefined, undefined, run),
        expected,
      );
      assert.equal(calls, 1);
    }
  }
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
