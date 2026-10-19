import { rejectsArgument, rejectsArguments } from "./argument-error.testing.ts";
/** Tool-level replace contracts: byte preservation, matching, and failures. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initTheme, type Theme } from "@earendil-works/pi-coding-agent";
import { makeReplaceTool } from "./replace-tool.ts";
import { validateToolArguments } from "@earendil-works/pi-ai";
import { callTool } from "./tool-call.testing.ts";
import { createActionFusionExecutor } from "./action-fusion.ts";
import { DEFAULT_CONFIG } from "./config.ts";
import { reportOf } from "./report.ts";

async function withDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "hl-replace-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const call = (tool: any, params: any) => callTool(tool, params, { toolCallId: "0" });

const stubTheme = { fg: (_k: string, s: string) => s, bold: (s: string) => s } as Theme;

// renderResult delegates to pi's renderDiff, which reads the global TUI theme
// singleton — initialize it once for this test process (watcher off by default).
initTheme();

test("replace schema requires a non-empty replacements array", async () => {
  for (const fusion of [undefined, createActionFusionExecutor()]) {
    const tool = makeReplaceTool(process.cwd(), DEFAULT_CONFIG, fusion);
    assert.equal(Object.hasOwn(tool.parameters.properties, "find"), false);
    const check = (args: Parameters<typeof validateToolArguments>[1]["arguments"]) =>
      validateToolArguments(tool, { type: "toolCall", id: "0", name: "replace", arguments: args });
    assert.doesNotThrow(() =>
      check({ path: "f.txt", replacements: [{ literal: true, find: "old", replace: "new" }] }),
    );
    const invalidArgs: Parameters<typeof validateToolArguments>[1]["arguments"][] = [
      { path: "f.txt", find: "old", replace: "new" },
      { path: "f.txt", replacements: [] },
      {
        path: "f.txt",
        replacements: [{ literal: true, find: "old", replace: "new" }],
        find: "old",
      },
      { path: "f.txt", replacements: '[{"find":"old","literal":true,"replace":"new"}]' },
      ...[1, null, false].map((maxMatches) => ({
        path: "f.txt",
        replacements: [{ literal: true, find: "old", replace: "new", maxMatches }],
      })),
    ];
    for (const args of invalidArgs) {
      await assert.rejects(call(tool, args), rejectsArguments());
    }
  }
});

test("replace schema rejects empty paths and empty find", async () => {
  const tool = makeReplaceTool(process.cwd(), DEFAULT_CONFIG);
  for (const args of [
    { path: "", replacements: [{ literal: true, find: "old", replace: "new" }] },
    { path: "f.txt", replacements: [{ literal: true, find: "", replace: "new" }] },
  ]) {
    await assert.rejects(call(tool, args), rejectsArguments(), JSON.stringify(args));
  }
});

test("replace rules omit literal or retain regex → reject before publication and fused commands", async () =>
  withDir(async (dir) => {
    const path = join(dir, "f.txt");
    await writeFile(path, "old\n");
    let commands = 0;
    const tool = makeReplaceTool(
      dir,
      DEFAULT_CONFIG,
      createActionFusionExecutor(async () => {
        commands++;
        return { status: "succeeded", result: { content: [] } };
      }),
    );
    for (const [rule, field, reason] of [
      [{ find: "old", replace: "new" }, "literal", /required/],
      [{ find: "old", replace: "new", literal: true, regex: true }, "regex", /not allowed/],
      [{ find: "old", replace: "new", literal: true, regex: false }, "regex", /not allowed/],
    ] as const) {
      await assert.rejects(
        callTool(tool, {
          path,
          replacements: [{ find: "old", literal: true, replace: "first" }, rule],
          then_run: { command: "check" },
        }),
        rejectsArgument(`replacements[1].${field}`, reason),
      );
      assert.equal(await readFile(path, "utf8"), "old\n");
    }
    assert.equal(commands, 0);
  }));

test("replace rejects top-level rules without publishing", async () =>
  withDir(async (dir) => {
    const file = join(dir, "f.txt");
    await writeFile(file, "old\n");
    await assert.rejects(
      callTool(makeReplaceTool(dir, DEFAULT_CONFIG), {
        path: file,
        find: "old",
        replace: "new",
      }),
      rejectsArgument("replacements"),
    );
    assert.equal(await readFile(file, "utf8"), "old\n");
  }));

test("replace rejects unsupported per-rule fields before publishing", async () =>
  withDir(async (dir) => {
    const file = join(dir, "f.txt");
    const before = "foo foo foo\n";
    await writeFile(file, before);
    const tool = makeReplaceTool(dir, DEFAULT_CONFIG);
    for (const maxMatches of [1, null, false]) {
      await assert.rejects(
        callTool(tool, {
          path: file,
          replacements: [{ literal: true, find: "foo", replace: "bar", maxMatches }],
        }),
        rejectsArgument("replacements[0].maxMatches", /not allowed/),
      );
      assert.equal(await readFile(file, "utf8"), before);
    }
  }));

test("replace rejects unwritable text and invalid regex before reading a missing target", async () =>
  withDir(async (dir) => {
    const file = join(dir, "missing.txt");
    const tool = makeReplaceTool(dir, DEFAULT_CONFIG);
    const valid = { path: file, replacements: [{ find: "x", replace: "y", literal: false }] };
    assert.equal(tool.prepareArguments(valid), valid);
    for (const [rule, expected] of [
      [
        { literal: true, find: "x", replace: "\0" },
        rejectsArgument("replacements[0].replace", /NUL/),
      ],
      [
        { literal: true, find: "x", replace: "\ud800" },
        rejectsArgument("replacements[0].replace", /losslessly.*UTF-8/),
      ],
      [
        { find: "(", replace: "x", literal: false },
        rejectsArgument("replacements[0].find", /Invalid regular expression/i),
      ],
    ] as const) {
      await assert.rejects(callTool(tool, { path: file, replacements: [rule] }), expected);
      await assert.rejects(readFile(file, "utf8"), { code: "ENOENT" });
    }
  }));

test("replace literal: replaces all occurrences", async () => {
  await withDir(async (dir) => {
    const f = join(dir, "f.txt");
    await writeFile(f, "foo bar foo baz foo\n");
    const r: any = await call(makeReplaceTool(dir, DEFAULT_CONFIG), {
      path: "f.txt",
      replacements: [{ literal: true, find: "foo", replace: "qux" }],
    });
    assert.equal(r.isError, undefined);
    assert.equal(await readFile(f, "utf-8"), "qux bar qux baz qux\n");
    assert.equal(reportOf(r, "replace")?.matches, 3);
  });
});

test("literal multiline replace matches LF and CRLF while retaining local separators", async () =>
  withDir(async (dir) => {
    const file = join(dir, "mixed.txt");
    await writeFile(file, "\uFEFFhead\r\nold\r\none\r\nmid\nold\none\nend\r\n");
    const result: any = await call(makeReplaceTool(dir, DEFAULT_CONFIG), {
      path: "mixed.txt",
      replacements: [{ literal: true, find: "old\none", replace: "NEW\nX" }],
    });
    assert.equal(reportOf(result, "replace")?.matches, 2);
    assert.equal(await readFile(file, "utf8"), "\uFEFFhead\r\nNEW\r\nX\r\nmid\nNEW\nX\nend\r\n");
    await call(makeReplaceTool(dir, DEFAULT_CONFIG), {
      path: "mixed.txt",
      replacements: [{ literal: true, find: "NEW\r\nX", replace: "done" }],
    });
    assert.equal(await readFile(file, "utf8"), "\uFEFFhead\r\ndone\r\nmid\ndone\nend\r\n");
  }));

test("both replacement modes preserve each matched separator", async () =>
  withDir(async (dir) => {
    const file = join(dir, "mixed.txt");
    for (const literal of [true, false]) {
      await writeFile(file, "a\r\nb\nc\r\ntail\n");
      await call(makeReplaceTool(dir, DEFAULT_CONFIG), {
        path: "mixed.txt",
        replacements: [{ find: "a\nb\nc", replace: "x\ny\nz\nextra", literal }],
      });
      assert.equal(await readFile(file, "utf8"), "x\r\ny\nz\nextra\r\ntail\n");
    }
  }));

test("literal replacement uses one LF view and preserves raw bytes across query styles", async () =>
  withDir(async (dir) => {
    const file = join(dir, "f.txt");
    for (const find of ["a\nb\nc", "a\r\nb\r\nc", "a\r\nb\nc"]) {
      const before = "\uFEFFhead\r\na\r\nb\nc\rtail";
      await writeFile(file, before);
      const result = await call(makeReplaceTool(dir, DEFAULT_CONFIG), {
        path: file,
        replacements: [{ literal: true, find, replace: find }],
      });
      assert.equal(await readFile(file, "utf8"), before);
      assert.equal(reportOf(result, "replace")?.matches, 1);
      assert.equal(reportOf(result, "replace")?.publication, "NOT_PUBLISHED");
    }
    for (const [before, find, replacement, expected] of [
      ["a\r\nb", "a", "A\nextra", "A\r\nextra\r\nb"],
      ["a\nb", "a\r\nb", "A\r\nB", "A\nB"],
      ["a\r\nb", "\n", "", "ab"],
      ["a\r\nb", "\n", "\n", "a\r\nb"],
      ["a\rb\r\r\nc", "a\rb\r\r\nc", "x\ry\r\r\nz", "x\ry\r\r\nz"],
    ]) {
      await writeFile(file, before);
      await call(makeReplaceTool(dir, DEFAULT_CONFIG), {
        path: file,
        replacements: [{ literal: true, find, replace: replacement }],
      });
      assert.equal(await readFile(file, "utf8"), expected);
    }
  }));

test("mixed literal and regex batches share raw offsets after CRLF normalization", async () =>
  withDir(async (dir) => {
    const file = join(dir, "f.txt");
    await writeFile(file, "😀\r\na\r\nb\r\nc");
    await call(makeReplaceTool(dir, DEFAULT_CONFIG), {
      path: file,
      replacements: [
        { literal: true, find: "a\nb", replace: "A\nB" },
        { find: "(c)$", replace: "$1!", literal: false },
      ],
    });
    assert.equal(await readFile(file, "utf8"), "😀\r\nA\r\nB\r\nc!");
    const before = await readFile(file, "utf8");
    const failed = await call(makeReplaceTool(dir, DEFAULT_CONFIG), {
      path: file,
      replacements: [
        { literal: true, find: "A\nB", replace: "x" },
        { find: "\\nB", replace: "y", literal: false },
      ],
    });
    assert.equal(failed.isError, true);
    assert.equal(reportOf(failed, "replace")?.error, "OVERLAPPING_MATCHES");
    assert.equal(await readFile(file, "utf8"), before);
  }));

test("replace literal: $ in replacement stays literal (no expansion)", async () => {
  await withDir(async (dir) => {
    const f = join(dir, "f.txt");
    await writeFile(f, "cost: $5 here\n");
    const r: any = await call(makeReplaceTool(dir, DEFAULT_CONFIG), {
      path: "f.txt",
      replacements: [{ literal: true, find: "$5", replace: "$1|$<name>|$&|$$" }],
    });
    assert.equal(r.isError, undefined);
    assert.equal(await readFile(f, "utf-8"), "cost: $1|$<name>|$&|$$ here\n");
  });
});

test("replace literal: case-insensitive via flags", async () => {
  await withDir(async (dir) => {
    const f = join(dir, "f.txt");
    await writeFile(f, "Foo fOo FOO\n");
    await call(makeReplaceTool(dir, DEFAULT_CONFIG), {
      path: "f.txt",
      replacements: [{ literal: true, find: "foo", replace: "x", flags: "i" }],
    });
    assert.equal(await readFile(f, "utf-8"), "x x x\n");
  });
});

test("replace aborts catastrophic regex without blocking the event loop or publishing", async () => {
  await withDir(async (dir) => {
    const file = join(dir, "f.txt");
    const before = `${"a".repeat(30)}!`;
    await writeFile(file, before);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 100);
    const start = performance.now();
    try {
      const failed = await callTool(
        makeReplaceTool(dir, DEFAULT_CONFIG),
        { path: file, replacements: [{ find: "^(a+)+$", replace: "x", literal: false }] },
        { toolCallId: "abort", signal: controller.signal, ctx: { cwd: dir } },
      );
      assert.equal(failed.isError, true);
      assert.equal(reportOf(failed, "replace")?.error, "OPERATION_ABORTED");
      assert.equal(reportOf(failed, "replace")?.publication, "NOT_PUBLISHED");
      assert.ok(performance.now() - start < 2000);
      assert.equal(await readFile(file, "utf8"), before);
    } finally {
      clearTimeout(timer);
    }
  });
});
test("replace times out catastrophic regex at the configured limit without publishing", async () => {
  await withDir(async (dir) => {
    const file = join(dir, "f.txt");
    const before = `${"a".repeat(35)}!`;
    await writeFile(file, before);
    const config = { ...DEFAULT_CONFIG, replace: { regexTimeoutMs: 1_000 } };
    const failed = await call(makeReplaceTool(dir, config), {
      path: file,
      replacements: [{ find: "^(a+)+$", replace: "x", literal: false }],
    });
    assert.equal(failed.isError, true);
    assert.equal(reportOf(failed, "replace")?.error, "REGEX_TIMEOUT");
    assert.equal(reportOf(failed, "replace")?.timeoutMs, config.replace.regexTimeoutMs);
    assert.equal(reportOf(failed, "replace")?.publication, "NOT_PUBLISHED");
    assert.equal(await readFile(file, "utf8"), before);
  });
});

test("replace regex: capture groups in replacement", async () => {
  await withDir(async (dir) => {
    const f = join(dir, "f.txt");
    await writeFile(f, "name: alice\nname: bob\n");
    await call(makeReplaceTool(dir, DEFAULT_CONFIG), {
      path: "f.txt",
      replacements: [{ find: "name: (\\w+)", replace: "user: $1", literal: false }],
    });
    assert.equal(await readFile(f, "utf-8"), "user: alice\nuser: bob\n");
  });
});

test("replace regex: multiline flag matches line-anchored pattern", async () => {
  await withDir(async (dir) => {
    const f = join(dir, "f.txt");
    await writeFile(f, "a\nb\nc\n");
    // without `m`, ^a$ wouldn't match (a isn't at end of string); with `m` it does
    await call(makeReplaceTool(dir, DEFAULT_CONFIG), {
      path: "f.txt",
      replacements: [{ find: "^a$", replace: "A", literal: false, flags: "m" }],
    });
    assert.equal(await readFile(f, "utf-8"), "A\nb\nc\n");
  });
});

test("replace regex: dotall flag makes . match newlines", async () => {
  await withDir(async (dir) => {
    const f = join(dir, "f.txt");
    await writeFile(f, "a\nb\n");
    // a.b only matches across the newline with the `s` (dotall) flag
    await call(makeReplaceTool(dir, DEFAULT_CONFIG), {
      path: "f.txt",
      replacements: [{ find: "a.b", replace: "X", literal: false, flags: "s" }],
    });
    assert.equal(await readFile(f, "utf-8"), "X\n");
  });
});

test("replace finds no matches → returns failure and leaves file untouched", async () => {
  await withDir(async (dir) => {
    const f = join(dir, "f.txt");
    await writeFile(f, "a\nb\n");
    const failed = await call(makeReplaceTool(dir, DEFAULT_CONFIG), {
      path: "f.txt",
      replacements: [{ literal: true, find: "zzz", replace: "y" }],
    });
    assert.equal(failed.isError, true);
    assert.equal(reportOf(failed, "replace")?.error, "NO_MATCH");
    assert.equal(reportOf(failed, "replace")?.rule, 0);
    assert.equal(await readFile(f, "utf-8"), "a\nb\n", "file untouched on 0-match failure");
  });
});

test("replace: empty find throws", async () => {
  await withDir(async (dir) => {
    await writeFile(join(dir, "f.txt"), "a\n");
    await assert.rejects(
      callTool(makeReplaceTool(dir, DEFAULT_CONFIG), {
        path: "f.txt",
        replacements: [{ literal: true, find: "", replace: "x" }],
      }),
      rejectsArgument("replacements[0].find"),
    );
  });
});

test("replace: handles large match counts without an arbitrary cap", async () => {
  await withDir(async (dir) => {
    const f = join(dir, "f.txt");
    await writeFile(f, "a\n".repeat(2500));
    const result: any = await call(makeReplaceTool(dir, DEFAULT_CONFIG), {
      path: "f.txt",
      replacements: [{ literal: true, find: "a", replace: "b" }],
    });
    assert.equal(reportOf(result, "replace")?.matches, 2500);
    assert.equal(await readFile(f, "utf-8"), "b\n".repeat(2500));
  });
});

test("replace: count-but-no-net-change does not rewrite and reports it", async () => {
  await withDir(async (dir) => {
    const f = join(dir, "f.txt");
    await writeFile(f, "xx\n");
    // $& = whole match = "x", so the text is unchanged despite 2 matches
    const r: any = await call(makeReplaceTool(dir, DEFAULT_CONFIG), {
      path: "f.txt",
      replacements: [{ find: "x", replace: "$&", literal: false }],
    });
    assert.equal(r.isError, undefined);
    assert.equal(await readFile(f, "utf-8"), "xx\n");
    assert.equal(reportOf(r, "replace")?.publication, "NOT_PUBLISHED");
    assert.equal(reportOf(r, "replace")?.matches, 2);
    assert.equal(r.details.diff, "");
  });
});

test("replace: returns details.diff (string) + patch + firstChangedLine", async () => {
  await withDir(async (dir) => {
    const f = join(dir, "f.txt");
    await writeFile(f, "a\nb\nc\n");
    const r: any = await call(makeReplaceTool(dir, DEFAULT_CONFIG), {
      path: "f.txt",
      replacements: [{ literal: true, find: "b", replace: "B" }],
    });
    assert.equal(typeof r.details.diff, "string");
    assert.equal(typeof r.details.patch, "string");
    assert.equal(typeof r.details.firstChangedLine, "number");
  });
});

test("multiline replacement → preserves the surrounding file text", async () => {
  await withDir(async (dir) => {
    const f = join(dir, "f.txt");
    await writeFile(f, "a\nb\nc\n");
    await call(makeReplaceTool(dir, DEFAULT_CONFIG), {
      path: "f.txt",
      replacements: [{ literal: true, find: "b", replace: "B1\nB2" }],
    });
    assert.equal(await readFile(f, "utf-8"), "a\nB1\nB2\nc\n");
  });
});

test("replace header retains the rule count when a long path wraps", () => {
  const tool = makeReplaceTool(process.cwd(), DEFAULT_CONFIG);
  const args = {
    path: "x".repeat(68),
    replacements: [
      { literal: true, find: "first", replace: "second" },
      { literal: true, find: "third", replace: "fourth" },
    ],
  };
  const header = tool.renderCall(args, stubTheme, {} as Parameters<typeof tool.renderCall>[2]);
  assert.match(header.render(120).join("\n"), /2 rules/);
  assert.match(header.render(80).join("\n"), /2\s+rules/);
});

test("replacement batches → evaluate every rule against one snapshot", async () =>
  withDir(async (dir) => {
    const file = join(dir, "batch.txt");
    const tool = makeReplaceTool(dir, DEFAULT_CONFIG);
    const args = {
      path: file,
      replacements: [
        { literal: true, find: "foo", replace: "bar" },
        { literal: true, find: "bar", replace: "baz" },
      ],
    };
    validateToolArguments(tool, { type: "toolCall", id: "0", name: "replace", arguments: args });
    await writeFile(file, "\uFEFFfoo\r\nbar\nfoo");
    const result = await call(tool, args);
    assert.equal(await readFile(file, "utf8"), "\uFEFFbar\r\nbaz\nbar");
    assert.equal(reportOf(result, "replace")?.matches, 3);
    assert.match(result.details.diff, /^\+2 baz/m);
  }));

test("invalid batches reject every change and never run a fused command", async () =>
  withDir(async (dir) => {
    const file = join(dir, "batch.txt");
    const before = "foo bar foo";
    await writeFile(file, before);
    let commands = 0;
    const tool = makeReplaceTool(
      dir,
      DEFAULT_CONFIG,
      createActionFusionExecutor(async () => {
        commands++;
        return { status: "succeeded", result: { content: [{ type: "text", text: "done" }] } };
      }),
    );
    const first = { literal: true, find: "bar", replace: "changed" };
    const cases = [
      [
        rejectsArgument("replacements[1].find", /Invalid regular expression/i),
        [{ replacements: [first, { find: "(", replace: "x", literal: false }] }],
      ],
      [
        rejectsArgument("replacements[1].replace", /NUL/),
        [{ replacements: [first, { literal: true, find: "foo", replace: "\0" }] }],
      ],
      [
        rejectsArgument("replacements[1].replace", /losslessly.*UTF-8/),
        [{ replacements: [first, { literal: true, find: "foo", replace: "\ud800" }] }],
      ],
      [
        rejectsArguments(),
        [
          { replacements: [first, { literal: true, find: "", replace: "x" }] },
          { replacements: [first, { literal: true, find: "foo" }] },
          { replacements: [] },
          { replacements: [first], find: "foo", replace: "x" },
          { replacements: [first], flags: "i" },
          {},
        ],
      ],
    ] as const;
    for (const [rule, code] of [
      [{ literal: true, find: "missing", replace: "x" }, "NO_MATCH"],
      [{ literal: true, find: "bar foo", replace: "x" }, "OVERLAPPING_MATCHES"],
      [{ literal: true, find: "bar", replace: "x" }, "OVERLAPPING_MATCHES"],
    ] as const) {
      const failed = await callTool(
        tool,
        { path: file, replacements: [first, rule], then_run: { command: "check" } },
        { ctx: { cwd: dir } },
      );
      assert.equal(failed.isError, true);
      assert.equal(reportOf(failed, "replace")?.error, code);
      assert.equal(reportOf(failed, "replace")?.then_run?.status, "skipped");
      assert.equal(reportOf(failed, "replace")?.publication, "NOT_PUBLISHED");
      assert.equal(await readFile(file, "utf8"), before);
    }
    for (const [expected, inputs] of cases) {
      for (const args of inputs) {
        await assert.rejects(
          callTool(
            tool,
            { path: file, ...args, then_run: { command: "check" } },
            {
              ctx: { cwd: dir },
            },
          ),
          expected,
        );
        assert.equal(await readFile(file, "utf8"), before);
      }
    }
    assert.equal(commands, 0);
  }));

test("adjacent matches and zero-width boundaries have deterministic batch semantics", async () =>
  withDir(async (dir) => {
    const file = join(dir, "batch.txt");
    const tool = makeReplaceTool(dir, DEFAULT_CONFIG);
    for (const rules of [
      [
        { literal: true, find: "a", replace: "b" },
        { literal: true, find: "b", replace: "a" },
      ],
      [
        { literal: true, find: "b", replace: "a" },
        { literal: true, find: "a", replace: "b" },
      ],
    ]) {
      await writeFile(file, "ab");
      await call(tool, { path: file, replacements: rules });
      assert.equal(await readFile(file, "utf8"), "ba");
    }
    for (const find of ["^", "(?=b)", "$"]) {
      await writeFile(file, "ab");
      const args = {
        path: file,
        replacements: [
          { literal: true, find: "ab", replace: "X" },
          { find, replace: "!", literal: false },
        ],
      };
      if (find === "$") {
        await call(tool, args);
        assert.equal(await readFile(file, "utf8"), "X!");
      } else {
        const failed = await call(tool, args);
        assert.equal(failed.isError, true);
        assert.equal(reportOf(failed, "replace")?.error, "OVERLAPPING_MATCHES");
        assert.equal(await readFile(file, "utf8"), "ab");
      }
    }
    await writeFile(file, "ab");
    const failed = await call(tool, {
      path: file,
      replacements: [
        { find: "^", replace: "x", literal: false },
        { find: "(?=a)", replace: "y", literal: false },
      ],
    });
    assert.equal(failed.isError, true);
    assert.equal(reportOf(failed, "replace")?.error, "OVERLAPPING_MATCHES");
    assert.equal(await readFile(file, "utf8"), "ab");
  }));

test("regex templates agree with native replacement in single and snapshot batch modes", async () =>
  withDir(async (dir) => {
    const file = join(dir, "regex.txt");
    const tool = makeReplaceTool(dir, DEFAULT_CONFIG);
    const template =
      "$$|$&|$`|$'|$0|$00|$01|$1|$2|$10|$12|$99|$<x>|$<missing>|$<>|$<$&>|$<unclosed$1|$";
    for (const [source, find, flags] of [
      ["ab b#", "(?<x>a)?b", "g"],
      ["ab b#", "(a)?b", "g"],
      ["ab#", "ab", "g"],
      ["abcdefghijkl#", "(a)(b)(c)(d)(e)(f)(g)(h)(i)(j)(k)(l)", "g"],
      ["ab ab#", "(?<=a)(b)", "g"],
      ["ab#", "(?=b)", "g"],
      ["😀#", "(?=[^#])", "gu"],
      ["aab#", "(a)", "gy"],
    ]) {
      const rule = { find, replace: template, literal: false, flags };
      const expected = source.replace(new RegExp(find, flags), template);
      for (const batch of [false, true]) {
        await writeFile(file, source);
        // The second rule changes only the original final sentinel, not copies inserted by $' or $`.
        const args = batch
          ? { replacements: [rule, { find: "#$", replace: "!", literal: false }] }
          : { replacements: [rule] };
        await call(tool, { path: file, ...args });
        assert.equal(
          await readFile(file, "utf8"),
          batch ? expected.slice(0, -1) + "!" : expected,
          `${find}/${flags}; batch=${batch}`,
        );
      }
    }
  }));

test("successful batches run one command against the complete result", async () =>
  withDir(async (dir) => {
    const file = join(dir, "batch.txt");
    await writeFile(file, "foo bar");
    let commands = 0;
    const tool = makeReplaceTool(
      dir,
      DEFAULT_CONFIG,
      createActionFusionExecutor(async (_toolCallId, input) => {
        assert.equal(input.command, "check");
        commands++;
        assert.equal(await readFile(file, "utf8"), "bar baz");
        return { status: "succeeded", result: { content: [{ type: "text", text: "checked" }] } };
      }),
    );
    const result = await tool.execute(
      "0",
      {
        path: file,
        replacements: [
          { literal: true, find: "foo", replace: "bar" },
          { literal: true, find: "bar", replace: "baz" },
        ],
        then_run: { command: "check" },
      },
      undefined,
      undefined,
      { cwd: dir } as Parameters<typeof tool.execute>[4],
    );
    assert.equal(commands, 1);
    assert.equal(reportOf(result, "replace")?.then_run?.status, "succeeded");
    assert.equal(reportOf(result, "replace")?.then_run?.output, "checked");
  }));

test("regex captures and zero-width insertions use logical offsets without consuming CRLF bytes", async () =>
  withDir(async (dir) => {
    const path = join(dir, "f.txt");
    const before = "a\r\nb\rc\r\r\n";
    await writeFile(path, before);
    await call(makeReplaceTool(dir, DEFAULT_CONFIG), {
      path,
      replacements: [{ find: "(b\rc\r)\\n", replace: "$1\n", literal: false }],
    });
    assert.equal(await readFile(path, "utf8"), before);
    await call(makeReplaceTool(dir, DEFAULT_CONFIG), {
      path,
      replacements: [{ find: "(?=\\n)", replace: "!", literal: false }],
    });
    assert.equal(await readFile(path, "utf8"), "a!\r\nb\rc\r!\r\n");
  }));

test("replace rejects JSON-string rules without publishing", async () =>
  withDir(async (dir) => {
    const file = join(dir, "f.txt");
    await writeFile(file, "hello foo world");
    const tool = makeReplaceTool(dir, DEFAULT_CONFIG);
    await assert.rejects(
      callTool(tool, {
        path: "f.txt",
        replacements: JSON.stringify([{ literal: true, find: "foo", replace: "bar" }]),
      }),
      rejectsArgument("replacements[0]", /object/),
    );
    assert.equal(await readFile(file, "utf8"), "hello foo world");
  }));
