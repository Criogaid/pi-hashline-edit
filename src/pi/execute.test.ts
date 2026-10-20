import { argumentError, rejectsArgument, rejectsArguments } from "./argument-error.testing.ts";
/** Tool-level edit and shared mutation workflow tests. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initTheme } from "@earendil-works/pi-coding-agent";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { validateToolArguments } from "@earendil-works/pi-ai";
import { makeEditOverride } from "./edit-tool.ts";
import { makeReadOverride } from "./read-tool.ts";
import { makeWriteOverride } from "./write-tool.ts";
import { makeReplaceTool } from "./replace-tool.ts";
import { createActionFusionExecutor } from "./action-fusion.ts";
import { computeLineHash } from "../core/hash.ts";
import { splitLines } from "../core/lines.ts";
import { callTool } from "./tool-call.testing.ts";
import { DEFAULT_CONFIG } from "./config.ts";
import { formatByteSize, DEFAULT_OUTPUT_BUDGETS } from "./budgets.ts";
import { detailsReport, reportOf } from "./report.ts";
import type { Report } from "./report-schema.ts";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";

async function withDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "hl-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Call a tool through Pi's argument preparation and schema validation, as production does. */
const call = (tool: any, params: any) => callTool(tool, params, { toolCallId: "0" });

/** Anchor a model would copy from read output for `line` of `text` (1-based). */
function h(text: string, line: number) {
  return `${line}#${computeLineHash(line, splitLines(text)[line - 1], 4)}`;
}

/** Extract a `LINE#HASH` anchor from a read/edit result text block. */
function anchorLine(block: string, line: number) {
  const m = new RegExp(`^${line}#([0-9A-Z]+)(?:│|$)`, "m").exec(block);
  if (!m) throw new Error(`line ${line} anchor not found in block`);
  return `${line}#${m[1]}`;
}

function failureReport(result: AgentToolResult<unknown> & { isError?: boolean }): Report {
  assert.equal(result.isError, true);
  const report = detailsReport(result.details);
  assert.ok(report?.error);
  return report;
}

test("edit guidance → refreshes anchors after content changes and line shifts", () => {
  const guidance = makeEditOverride(process.cwd(), DEFAULT_CONFIG).promptGuidelines.join("\n");
  assert.match(guidance, /after edit or replace.*before citing any line it changed/i);
  assert.match(
    guidance,
    /added or removed lines.*refresh anchors below the earliest affected line/i,
  );
  assert.match(
    guidance,
    /affected positions are unknown.*read or grep the lines you intend to cite/i,
  );
});

test("edit execute: a file without a final newline stays byte-exact", async () => {
  await withDir(async (dir) => {
    const f = join(dir, "f.txt");
    // The benchmark's literal-1-no-final-newline fixture: no terminator, plus a
    // word-joiner the model cannot see. Only line 2 may change; the missing
    // terminator must not turn into a new byte.
    const text = "guard\nold value\u2060";
    await writeFile(f, text);
    await call(makeReadOverride(dir, DEFAULT_CONFIG), { path: "f.txt" });
    const r: any = await call(makeEditOverride(dir, DEFAULT_CONFIG), {
      path: "f.txt",
      edits: [{ op: "replace", anchor: h(text, 2), body: ["new value\u2060"] }],
    });
    assert.equal(r.isError, undefined, "should not be an error");
    assert.equal(await readFile(f, "utf-8"), "guard\nnew value\u2060");
  });
});

test("edit execute: hashline round-trip (read → edit → file changed)", async () => {
  await withDir(async (dir) => {
    const f = join(dir, "f.txt");
    const text = "a\nb\nc\n";
    await writeFile(f, text);
    const read = await call(makeReadOverride(dir, DEFAULT_CONFIG), { path: "f.txt" });
    const r: any = await call(makeEditOverride(dir, DEFAULT_CONFIG), {
      path: "f.txt",
      edits: [{ op: "replace", anchor: anchorLine(read.content[0].text, 2), body: ["B"] }],
    });
    assert.equal(r.isError, undefined, "should not be an error");
    assert.equal(await readFile(f, "utf-8"), "a\nB\nc\n");
  });
});

test("edit execute: multiple ops in one call", async () => {
  await withDir(async (dir) => {
    const f = join(dir, "f.txt");
    const text = "a\nb\nc\n";
    await writeFile(f, text);
    await call(makeReadOverride(dir, DEFAULT_CONFIG), { path: "f.txt" });
    const r: any = await call(makeEditOverride(dir, DEFAULT_CONFIG), {
      path: "f.txt",
      edits: [
        { op: "insert_after", anchor: h(text, 3), body: ["z"] },
        { op: "replace", anchor: h(text, 1), body: ["A"] },
      ],
    });
    assert.equal(r.isError, undefined);
    assert.equal(await readFile(f, "utf-8"), "A\nb\nc\nz\n");
  });
});

test("successful mutation → returns one report without anchor payload", async (t) => {
  for (const tool of ["edit", "replace", "write"] as const) {
    for (const count of [1, 3000]) {
      await t.test(`${tool}: ${count} changed lines`, async () =>
        withDir(async (dir) => {
          const path = "f.txt";
          const before = "old\n".repeat(count);
          const after = "new\n".repeat(count);
          await writeFile(join(dir, path), before);
          const inspection = await callTool(makeReadOverride(dir, DEFAULT_CONFIG), {
            path,
            limit: count,
          });
          assert.equal(inspection.content[0].type, "text");
          const rows = inspection.content[0].text;
          const fixture =
            tool === "edit"
              ? {
                  instance: makeEditOverride(dir, DEFAULT_CONFIG),
                  params: {
                    path,
                    edits: [
                      {
                        op: "replace",
                        anchor: anchorLine(rows, 1),
                        end: anchorLine(rows, count),
                        body: Array.from({ length: count }, () => "new"),
                      },
                    ],
                  },
                }
              : tool === "replace"
                ? {
                    instance: makeReplaceTool(dir, DEFAULT_CONFIG),
                    params: {
                      path,
                      replacements: [{ literal: true, find: "old", replace: "new" }],
                    },
                  }
                : {
                    instance: makeWriteOverride(dir),
                    params: { path, mode: "overwrite", content: after },
                  };
          const result = await callTool(fixture.instance, fixture.params);
          assert.equal(result.isError, undefined);
          assert.equal(await readFile(join(dir, path), "utf8"), after);
          assert.equal(result.content.length, 1);
          assert.equal(result.content[0].type, "text");
          assert.deepEqual(JSON.parse(result.content[0].text), {
            publication: "PUBLISHED",
            ...(tool === "replace" ? { matches: count } : {}),
          });
          if (tool !== "write") {
            assert.ok("diff" in result.details && typeof result.details.diff === "string");
            assert.match(result.details.diff, /new/);
          } else assert.deepEqual(result.details, { report: reportOf(result, "write") });
        }),
      );
    }
  }
});

test("unrelated external change does NOT block an edit on a stable line", async () => {
  await withDir(async (dir) => {
    const f = join(dir, "f.txt");
    const text = "a\nb\nc\n";
    await writeFile(f, text);
    // simulate an external change at line 3 between read and edit
    await writeFile(f, "a\nb\nCHANGED\n");
    const r: any = await call(makeEditOverride(dir, DEFAULT_CONFIG), {
      path: "f.txt",
      edits: [{ op: "replace", anchor: h(text, 1), body: ["A"] }],
    });
    assert.equal(r.isError, undefined);
    assert.equal(await readFile(f, "utf-8"), "A\nb\nCHANGED\n");
  });
});

test("edit on a line that changed externally → anchor mismatch", async () => {
  await withDir(async (dir) => {
    const f = join(dir, "f.txt");
    const text = "a\nb\nc\n";
    await writeFile(f, text);
    await writeFile(f, "a\nBCHANGED\nc\n"); // line 2 changed
    const report = failureReport(
      await call(makeEditOverride(dir, DEFAULT_CONFIG), {
        path: "f.txt",
        edits: [{ op: "replace", anchor: h(text, 2), body: ["x"] }],
      }),
    );
    assert.equal(report.error, "ANCHOR_MISMATCH");
    assert.equal(await readFile(f, "utf8"), "a\nBCHANGED\nc\n");
  });
});

test("unresolved observations require target confirmation before retrying a moved target", async () => {
  await withDir(async (dir) => {
    const file = join(dir, "recover.txt");
    const observed =
      ["one", "two", "three", "four", "old marker", "six", "seven", "eight"].join("\n") + "\n";
    await writeFile(
      file,
      ["one", "two", "three", "four", "changed", "six", "new marker", "eight"].join("\n") + "\n",
    );
    const edit = makeEditOverride(dir, DEFAULT_CONFIG);
    const report = failureReport(
      await call(edit, {
        path: "recover.txt",
        edits: [{ op: "replace", anchor: h(observed, 5), body: ["updated"] }],
      }),
    );
    assert.equal(report.error, "ANCHOR_MISMATCH");
    assert.equal(report.publication, "NOT_PUBLISHED");
    assert.match(report.next ?? "", /Before reusing.*anchor, confirm.*intended target/);
    assert.match(report.failures?.[0].observed ?? "", /^5#[0-9A-Z]+│changed$/);
    const read = await call(makeReadOverride(dir, DEFAULT_CONFIG), { path: "recover.txt" });
    const retryAnchor = anchorLine(read.content[0].text, 7);
    await call(edit, {
      path: "recover.txt",
      edits: [{ op: "replace", anchor: retryAnchor, body: ["updated"] }],
    });
    assert.equal(
      await readFile(file, "utf8"),
      "one\ntwo\nthree\nfour\nchanged\nsix\nupdated\neight\n",
    );
  });
});

test("edit execute: no read before edit → anchor verification fails", async () => {
  await withDir(async (dir) => {
    await writeFile(join(dir, "f.txt"), "a\nb\n");
    const report = failureReport(
      await call(makeEditOverride(dir, DEFAULT_CONFIG), {
        path: "f.txt",
        edits: [{ op: "replace", anchor: "1#XXXX", body: ["A"] }],
      }),
    );
    assert.equal(report.error, "ANCHOR_MISMATCH");
    assert.equal(await readFile(join(dir, "f.txt"), "utf8"), "a\nb\n");
  });
});

test("edit execute: delete op", async () => {
  await withDir(async (dir) => {
    const f = join(dir, "f.txt");
    const text = "a\nb\nc\n";
    await writeFile(f, text);
    await call(makeReadOverride(dir, DEFAULT_CONFIG), { path: "f.txt" });
    const r: any = await call(makeEditOverride(dir, DEFAULT_CONFIG), {
      path: "f.txt",
      edits: [{ op: "delete", anchor: h(text, 2) }],
    });
    assert.equal(r.isError, undefined);
    assert.equal(await readFile(f, "utf-8"), "a\nc\n");
  });
});

const stubTheme = { fg: (_k: string, s: string) => s, bold: (s: string) => s } as Theme;

// renderResult delegates to pi's renderDiff, which reads the global TUI theme
// singleton — initialize it once for this test process (watcher off by default).
initTheme();

test("native read and write renderers preserve resource titles, previews, and full errors", async () =>
  withDir(async (dir) => {
    const context = {
      cwd: dir,
      state: {},
      argsComplete: true,
      expanded: false,
      isPartial: false,
      lastComponent: undefined,
    };
    const read = makeReadOverride(dir, DEFAULT_CONFIG);
    const readCall = read.renderCall!({ path: "SKILL.md", offset: 2, limit: 3 }, stubTheme, {
      ...context,
      args: { path: "SKILL.md" },
    } as Parameters<NonNullable<typeof read.renderCall>>[2]);
    assert.match(readCall.render(120).join("\n"), /\[skill\]/);
    const write = makeWriteOverride(dir);
    const writeCall = write.renderCall(
      { path: "preview.txt", content: "native content preview\n", mode: "create" },
      stubTheme,
      context as Parameters<typeof write.renderCall>[2],
    );
    assert.match(writeCall.render(120).join("\n"), /native content preview/);
    const error = write.renderResult(
      {
        content: [{ type: "text", text: "first error\nsecond error" }],
        details: {},
      },
      { isPartial: false, expanded: false },
      stubTheme,
      { ...context, isError: true } as Parameters<typeof write.renderResult>[3],
    );
    assert.match(error.render(120).join("\n"), /first error[\s\S]*second error/);
  }));

test("edit schema rejects misspelled range fields and invalid operation shapes", async () =>
  withDir(async (dir) => {
    const original = "a\nb\nc\n";
    await writeFile(join(dir, "range.txt"), original);
    const edit = makeEditOverride(dir, DEFAULT_CONFIG);
    const anchor = h(original, 2);
    const callArgs = {
      path: "range.txt",
      edits: [{ op: "replace", anchor, endd: h(original, 3), body: ["merged"] }],
    };
    await assert.rejects(call(edit, callArgs), rejectsArgument("edits[0].endd", /not allowed/));
    assert.equal(await readFile(join(dir, "range.txt"), "utf8"), original);
    for (const [edits, expected] of [
      [[], rejectsArgument("edits")],
      [[{ op: "replace", anchor }], rejectsArgument("edits[0].body", /required/)],
      [[{ op: "delete", anchor, body: ["bad"] }], rejectsArguments()],
      [[{ op: "insert_after", body: ["bad"] }], rejectsArguments()],
      [[{ op: "append", anchor, body: ["bad"] }], rejectsArguments()],
    ] as const) {
      await assert.rejects(call(edit, { path: "range.txt", edits }), expected);
      assert.equal(await readFile(join(dir, "range.txt"), "utf8"), original);
    }
    const alternates: Parameters<typeof validateToolArguments>[1]["arguments"][] = [
      { path: "range.txt", op: "replace", anchor, body: ["ok"] },
      { path: "range.txt", edits: JSON.stringify([{ op: "replace", anchor, body: ["ok"] }]) },
    ];
    for (const alternate of alternates) {
      const before = structuredClone(alternate);
      await assert.rejects(call(edit, alternate), rejectsArguments());
      assert.deepEqual(alternate, before);
      assert.equal(await readFile(join(dir, "range.txt"), "utf8"), original);
    }
    await call(edit, { path: "range.txt", edits: [{ op: "replace", anchor, body: ["B"] }] });
    assert.equal(await readFile(join(dir, "range.txt"), "utf8"), "a\nB\nc\n");
  }));

test("copied string anchors validate and replace an inclusive range", async () =>
  withDir(async (dir) => {
    const original = "a\nb\nc\nd\n";
    await writeFile(join(dir, "range.txt"), original);
    const read = await call(makeReadOverride(dir, DEFAULT_CONFIG), { path: "range.txt" });
    const edit = makeEditOverride(dir, DEFAULT_CONFIG);
    const args = validateToolArguments(edit as any, {
      type: "toolCall",
      id: "range",
      name: "edit",
      arguments: {
        path: "range.txt",
        edits: [
          {
            op: "replace",
            anchor: anchorLine(read.content[0].text, 2),
            end: anchorLine(read.content[0].text, 3),
            body: ["merged"],
          },
        ],
      },
    });
    await call(edit, args);
    assert.equal(await readFile(join(dir, "range.txt"), "utf8"), "a\nmerged\nd\n");
  }));

test("invalid anchors and conflicting fields fail before changing the file", async () =>
  withDir(async (dir) => {
    const original = "a\nb\n";
    await writeFile(join(dir, "invalid.txt"), original);
    const edit = makeEditOverride(dir, DEFAULT_CONFIG);
    const anchor = h(original, 1);
    const invalid = [
      { op: "replace", anchor: { line: 1, hash: anchor.split("#")[1] }, body: ["changed"] },
      ...["0#ABCD", "-1#ABCD", "1.5#ABCD", "1#", "1#abcd", "1#ABCD│a", "9007199254740993#ABCD"].map(
        (anchor) => ({ op: "replace", anchor, body: ["changed"] }),
      ),
      { op: "insert_after", anchor, end: anchor, body: ["changed"] },
      { op: "append", anchor, body: ["changed"] },
      { op: "delete", anchor, body: ["changed"] },
    ];
    for (const operation of invalid) {
      await assert.rejects(
        call(edit, { path: "invalid.txt", edits: [operation] }),
        /INVALID_ARGUMENTS|Invalid anchor/,
      );
      assert.equal(await readFile(join(dir, "invalid.txt"), "utf8"), original);
    }
  }));

test("edit rejects empty bodies before file access for arrays and Pi-converted objects", async () =>
  withDir(async (dir) => {
    const original = "a\nb\nc\n";
    const file = join(dir, "empty_body.txt");
    await writeFile(file, original);
    const edit = makeEditOverride(dir, DEFAULT_CONFIG);
    const anchor = h(original, 1);
    for (const operation of [
      { op: "insert_after", anchor, body: [] },
      { op: "insert_before", anchor, body: [] },
      { op: "append", body: [] },
      { op: "prepend", body: [] },
      { op: "replace", anchor, end: h(original, 2), body: [] },
    ]) {
      for (const path of [file, join(dir, "missing.txt")]) {
        for (const edits of [[operation], operation]) {
          await assert.rejects(
            call(edit, { path, edits }),
            rejectsArgument("edits[0].body", /empty/),
          );
          assert.equal(await readFile(file, "utf8"), original);
        }
      }
    }
  }));

test("mixed empty-body batches name every rejected edit without publishing or running commands", async () =>
  withDir(async (dir) => {
    const file = join(dir, "batch.txt");
    const original = "a\nb\nc\nd\ne\n";
    await writeFile(file, original);
    let commandRuns = 0;
    const fusion = createActionFusionExecutor(async () => {
      commandRuns++;
      return { status: "succeeded", result: { content: [{ type: "text", text: "ran" }] } };
    });
    const edit = makeEditOverride(dir, DEFAULT_CONFIG, fusion);
    await assert.rejects(
      callTool(
        edit,
        {
          path: file,
          edits: [
            { op: "replace", anchor: h(original, 1), body: ["must not be written"] },
            { op: "insert_before", anchor: h(original, 3), body: [] },
            { op: "append", body: ["must not be written"] },
            { op: "replace", anchor: h(original, 4), body: [] },
          ],
          then_run: { command: "must-not-run" },
        },
        { ctx: { cwd: dir } },
      ),
      (error: Error) => {
        const issues = argumentError(error).issues;
        assert.match(issues.find((issue) => issue.field === "edits[1].body")?.fix ?? "", /\[""\]/);
        assert.match(issues.find((issue) => issue.field === "edits[3].body")?.fix ?? "", /delete/);
        return true;
      },
    );
    assert.equal(await readFile(file, "utf8"), original);
    assert.equal(commandRuns, 0);
  }));

test("blank edit bodies preserve a real blank line for every body-bearing operation", async () =>
  withDir(async (dir) => {
    const file = join(dir, "blank_line.txt");
    const original = "a\nb\nc\n";
    const anchor = h(original, 1);
    const edit = makeEditOverride(dir, DEFAULT_CONFIG);
    for (const [operation, expected] of [
      [{ op: "replace", anchor, body: [""] }, "\nb\nc\n"],
      [{ op: "insert_before", anchor, body: [""] }, "\na\nb\nc\n"],
      [{ op: "insert_after", anchor, body: [""] }, "a\n\nb\nc\n"],
      [{ op: "append", body: [""] }, "a\nb\nc\n\n"],
      [{ op: "prepend", body: [""] }, "\na\nb\nc\n"],
    ] as const) {
      await writeFile(file, original);
      await call(edit, { path: file, edits: [operation] });
      assert.equal(await readFile(file, "utf8"), expected);
    }
  }));

test("explicit delete → removes an inclusive range", async () =>
  withDir(async (dir) => {
    const original = "a\nb\nc\n";
    const file = join(dir, "delete_range.txt");
    await writeFile(file, original);
    await call(makeEditOverride(dir, DEFAULT_CONFIG), {
      path: file,
      edits: [{ op: "delete", anchor: h(original, 1), end: h(original, 2) }],
    });
    assert.equal(await readFile(file, "utf8"), "c\n");
  }));

test("local and full-file recovery return copyable anchors without changing the rejected batch", async () =>
  withDir(async (dir) => {
    const original = "a\nb\n";
    const edit = makeEditOverride(dir, DEFAULT_CONFIG);
    for (const prefixLines of [1, 40]) {
      const prefix = "prefix\n".repeat(prefixLines);
      await writeFile(join(dir, "shift.txt"), prefix + original);
      let replacement = "";
      const report = failureReport(
        await call(edit, {
          path: "shift.txt",
          edits: [{ op: "replace", anchor: h(original, 2), body: ["B"] }],
        }),
      );
      const failure = report.failures?.[0];
      assert.ok(failure);
      replacement = failure.candidate ?? "";
      assert.equal(replacement, h(prefix + original, prefixLines + 2));
      assert.equal(failure.content, "b");
      assert.equal(failure.search, prefixLines === 1 ? "local window" : "full file");
      assert.match(report.next ?? "", /confirm.*intended target/);
      assert.equal(report.candidateNeighborhoods, undefined);
      assert.equal(await readFile(join(dir, "shift.txt"), "utf8"), prefix + original);
      await call(edit, {
        path: "shift.txt",
        edits: [{ op: "replace", anchor: replacement, body: ["B"] }],
      });
      assert.equal(await readFile(join(dir, "shift.txt"), "utf8"), prefix + "a\nB\n");
    }
  }));

test("shifted-anchor recovery keeps the read fallback for oversized candidates", async () =>
  withDir(async (dir) => {
    const oversized = "x".repeat(DEFAULT_OUTPUT_BUDGETS.fieldBytes);
    const original = `a\n${oversized}\n`;
    await writeFile(join(dir, "shift-large.txt"), `prefix\n${original}`);
    const edit = makeEditOverride(dir, DEFAULT_CONFIG);
    const report = failureReport(
      await call(edit, {
        path: "shift-large.txt",
        edits: [{ op: "replace", anchor: h(original, 2), body: ["B"] }],
      }),
    );
    assert.match(
      report.failures?.[0].omitted ?? "",
      new RegExp(`exceeds ${formatByteSize(DEFAULT_OUTPUT_BUDGETS.fieldBytes)}`),
    );
    assert.match(report.next ?? "", /use read or grep/);
    assert.equal(report.failures?.[0].content, undefined);
  }));

test("failed commands preserve mutation results and stay out of all main card renderers", async () =>
  withDir(async (dir) => {
    const commands: string[] = [];
    const fusion = createActionFusionExecutor(
      async () => {
        throw new Error("command-only diagnostic\nCommand exited with code 7");
      },
      (event) => commands.push(event.command),
    );
    const cases = [
      {
        path: "edit.txt",
        run: async () => {
          const tool = makeEditOverride(dir, DEFAULT_CONFIG, fusion);
          const args = { path: "edit.txt", edits: [{ op: "append" as const, body: ["after"] }] };
          const result = await callTool(
            tool,
            { ...args, then_run: { command: "check" } },
            {
              toolCallId: args.path,
              ctx: { cwd: dir },
            },
          );
          return {
            result,
            rendered: tool
              .renderResult(
                result,
                { expanded: true, isPartial: false },
                stubTheme as Theme,
                { args, state: {}, cwd: dir, isError: false } as Parameters<
                  typeof tool.renderResult
                >[3],
              )
              .render(120)
              .join("\n"),
          };
        },
        expected: "before\nafter\n",
      },
      {
        path: "replace.txt",
        run: async () => {
          const tool = makeReplaceTool(dir, DEFAULT_CONFIG, fusion);
          const args = {
            path: "replace.txt",
            replacements: [{ literal: true, find: "before", replace: "after" }],
          };
          const result = await callTool(
            tool,
            { ...args, then_run: { command: "check" } },
            {
              toolCallId: args.path,
              ctx: { cwd: dir },
            },
          );
          return {
            result,
            rendered: tool
              .renderResult(
                result,
                { expanded: true, isPartial: false },
                stubTheme as Theme,
                { args, state: {}, cwd: dir, isError: false } as Parameters<
                  typeof tool.renderResult
                >[3],
              )
              .render(120)
              .join("\n"),
          };
        },
        expected: "after\n",
      },
      {
        path: "write.txt",
        run: async () => {
          const tool = makeWriteOverride(dir, fusion);
          const args = { path: "write.txt", content: "after\n", mode: "overwrite" as const };
          const result = await callTool(
            tool,
            { ...args, then_run: { command: "check" } },
            {
              toolCallId: args.path,
              ctx: { cwd: dir },
            },
          );
          return {
            result,
            rendered: tool
              .renderResult(result, { expanded: true, isPartial: false }, stubTheme as Theme, {
                args,
                state: {},
                cwd: dir,
                toolCallId: args.path,
                invalidate() {},
                lastComponent: undefined,
                executionStarted: true,
                argsComplete: true,
                isPartial: false,
                expanded: true,
                showImages: false,
                isError: false,
              })
              .render(120)
              .join("\n"),
          };
        },
        expected: "after\n",
      },
    ];
    for (const { path, run, expected } of cases) {
      await writeFile(join(dir, path), "before\n");
      const { result, rendered } = await run();
      assert.equal("isError" in result, false);
      const report = detailsReport(result.details);
      assert.equal(report?.publication, "PUBLISHED");
      const last = result.content.at(-1);
      assert.ok(last?.type === "text");
      assert.equal(report?.then_run?.status, "failed");
      assert.match(report?.then_run?.output ?? "", /command-only diagnostic/);
      if (path !== "write.txt")
        assert.equal(typeof ("diff" in result.details ? result.details.diff : undefined), "string");
      assert.doesNotMatch(rendered, /command-only diagnostic|then_run:failed/);
      assert.equal(await readFile(join(dir, path), "utf8"), expected);
    }
    assert.deepEqual(
      commands,
      cases.flatMap(() => ["waiting", "waiting", "running", "failed"]),
    );
  }));

test("text tools reject malformed UTF-8 and NUL bytes without rewriting source bytes", async () =>
  withDir(async (dir) => {
    const target = join(dir, "invalid-utf8.txt");
    const original = Buffer.from([0x61, 0x0a, 0xc3, 0x28, 0x0a]);
    await writeFile(target, original);
    for (const [tool, args] of [
      [makeReadOverride(dir, DEFAULT_CONFIG), { path: "invalid-utf8.txt" }],
      [
        makeEditOverride(dir, DEFAULT_CONFIG),
        { path: "invalid-utf8.txt", edits: [{ op: "append", body: ["x"] }] },
      ],
      [
        makeReplaceTool(dir, DEFAULT_CONFIG),
        { path: "invalid-utf8.txt", replacements: [{ literal: true, find: "a", replace: "b" }] },
      ],
    ] as const) {
      assert.equal(failureReport(await call(tool, args)).error, "UNSUPPORTED_ENCODING");
    }
    assert.deepEqual(await readFile(target), original);

    const nulTarget = join(dir, "nul.txt");
    const nulOriginal = Buffer.from([0x61, 0x00, 0x62]);
    await writeFile(nulTarget, nulOriginal);
    for (const [tool, args] of [
      [
        makeEditOverride(dir, DEFAULT_CONFIG),
        { path: "nul.txt", edits: [{ op: "append", body: ["x"] }] },
      ],
      [
        makeReplaceTool(dir, DEFAULT_CONFIG),
        { path: "nul.txt", replacements: [{ literal: true, find: "a", replace: "b" }] },
      ],
    ] as const) {
      assert.equal(failureReport(await call(tool, args)).error, "UNSUPPORTED_TEXT");
    }
    assert.deepEqual(await readFile(nulTarget), nulOriginal);

    const nativeRead: any = await call(makeReadOverride(dir, DEFAULT_CONFIG), { path: "nul.txt" });
    assert.equal(nativeRead.content[0].text, "a\0b");

    const utf16Target = join(dir, "utf16.txt");
    await writeFile(utf16Target, Buffer.from([0xff, 0xfe, 0x49, 0x6c]));
    assert.equal(
      failureReport(await call(makeReadOverride(dir, DEFAULT_CONFIG), { path: "utf16.txt" })).error,
      "UNSUPPORTED_ENCODING",
    );
  }));

test("edit rejects embedded line terminators at its schema boundary", async () =>
  withDir(async (dir) => {
    const target = join(dir, "body.txt");
    await writeFile(target, "a\n");
    for (const line of ["x\ny", "x\ry"]) {
      await assert.rejects(
        call(makeEditOverride(dir, DEFAULT_CONFIG), {
          path: "body.txt",
          edits: [{ op: "append", body: [line] }],
        }),
        rejectsArguments(),
      );
      assert.equal(await readFile(target, "utf8"), "a\n");
    }
  }));

test("edit rejects unwritable body lines before reading a missing target", async () =>
  withDir(async (dir) => {
    const target = join(dir, "missing.txt");
    const edit = makeEditOverride(dir, DEFAULT_CONFIG);
    const valid = { path: target, edits: [{ op: "append" as const, body: ["ok"] }] };
    assert.equal(edit.prepareArguments(valid), valid);
    for (const [line, expected] of [
      ["bad\0", rejectsArgument("edits[0].body[1]", /NUL/)],
      ["\ud800", rejectsArgument("edits[0].body[1]", /losslessly.*UTF-8/)],
    ] as const) {
      await assert.rejects(
        call(edit, { path: target, edits: [{ op: "append", body: ["ok", line] }] }),
        expected,
      );
      await assert.rejects(readFile(target, "utf8"), { code: "ENOENT" });
    }
  }));

test("editing a BOM-prefixed file → publishes the changed bytes with the BOM intact", async () =>
  withDir(async (dir) => {
    const target = join(dir, "bom.txt");
    const source = "\ufeffguard\nold\n";
    const original = Buffer.from(source, "utf8");
    for (const line of [1, 2]) {
      await writeFile(target, original);
      const result = await call(makeEditOverride(dir, DEFAULT_CONFIG), {
        path: "bom.txt",
        edits: [{ op: "replace", anchor: h(source, line), body: ["new"] }],
      });
      const expected = Buffer.from(line === 1 ? "\ufeffnew\nold\n" : "\ufeffguard\nnew\n", "utf8");
      assert.deepEqual(await readFile(target), expected);
      assert.equal(reportOf(result, "edit")?.publication, "PUBLISHED");
      assert.equal(reportOf(result, "edit")?.freshness, undefined);
    }
  }));

test("edit and replace reject NUL arguments without rewriting source bytes", async () =>
  withDir(async (dir) => {
    const target = join(dir, "output.txt");
    const original = Buffer.from("\ufeffbefore\r\n", "utf8");
    await writeFile(target, original);
    await assert.rejects(
      call(makeEditOverride(dir, DEFAULT_CONFIG), {
        path: "output.txt",
        edits: [{ op: "append", body: ["bad\0text"] }],
      }),
      rejectsArgument("edits[0].body[0]", /NUL/),
    );
    assert.deepEqual(await readFile(target), original);
    await assert.rejects(
      call(makeReplaceTool(dir, DEFAULT_CONFIG), {
        path: "output.txt",
        replacements: [{ literal: true, find: "before", replace: "bad\0text" }],
      }),
      rejectsArgument("replacements[0].replace", /NUL/),
    );
    assert.deepEqual(await readFile(target), original);
  }));

test("failed edits expose input status and candidate code for a verified fused retry", async () =>
  withDir(async (dir) => {
    const original = Array.from({ length: 14 }, (_, index) => `line-${index + 1}`);
    original[4] = "if (!fusion) throw new Error();";
    original[5] = "const absolutePath = canonicalPath(cwd, path);";
    const before = `prefix\n${original.join("\n")}\n`;
    const file = join(dir, "candidate.txt");
    await writeFile(file, before);
    let commands = 0;
    const fusion = createActionFusionExecutor(async () => {
      commands++;
      return { status: "succeeded", result: { content: [{ type: "text", text: "checked" }] } };
    });
    const edit = makeEditOverride(dir, DEFAULT_CONFIG, fusion);
    const stale = h(original.join("\n"), 5);
    const stable = h(before, 12);
    const candidate = h(before, 6);
    const report = failureReport(
      await callTool(
        edit,
        {
          path: file,
          edits: [
            { op: "insert_after", anchor: stale, body: ["const hashLen = 4;"] },
            { op: "replace", anchor: stable, body: ["changed"] },
          ],
          then_run: { command: "check" },
        },
        { toolCallId: "failed", ctx: { cwd: dir } },
      ),
    );
    assert.equal(report.then_run?.status, "skipped");
    assert.deepEqual(report.matched, ["edits[1].anchor"]);
    assert.equal(report.failures?.[0].field, "edits[0].anchor");
    assert.equal(report.failures?.[0].cited, stale);
    assert.equal(report.failures?.[0].candidate, candidate);
    assert.equal(report.failures?.[0].content, original[4]);
    assert.equal(report.candidateNeighborhoods, undefined);
    assert.equal(report.omittedFailures, undefined);
    assert.equal(await readFile(file, "utf8"), before);
    assert.equal(commands, 0);
    await callTool(
      edit,
      {
        path: file,
        edits: [
          {
            op: "insert_after",
            anchor: report.failures![0].candidate!,
            body: ["const hashLen = 4;"],
          },
          { op: "replace", anchor: stable, body: ["changed"] },
        ],
        then_run: { command: "check" },
      },
      { toolCallId: "retry", ctx: { cwd: dir } },
    );
    const expected = splitLines(before);
    expected[11] = "changed";
    expected.splice(6, 0, "const hashLen = 4;");
    assert.equal(await readFile(file, "utf8"), `${expected.join("\n")}\n`);
    assert.equal(commands, 1);
  }));

test("ambiguous candidates include distinguishing neighborhoods for a verified retry", async () =>
  withDir(async (dir) => {
    const lines = Array.from({ length: 20 }, (_, index) => `line-${index + 1}`);
    lines[3] = "function primary() {";
    lines[4] = "  return value;";
    lines[13] = "function secondary() {";
    lines[14] = "  return value;";
    const before = lines.join("\n") + "\n";
    const file = join(dir, "ambiguous.txt");
    await writeFile(file, before);
    const edit = makeEditOverride(dir, DEFAULT_CONFIG);
    const report = failureReport(
      await call(edit, {
        path: file,
        edits: [
          { op: "replace", anchor: h("header\n  return value;\n", 2), body: ["  return updated;"] },
        ],
      }),
    );
    assert.equal(report.failures?.[0].result, "ambiguous");
    assert.equal(report.failures?.[0].search, "local window");
    assert.deepEqual(report.failures?.[0].candidates, [h(before, 5), h(before, 15)]);
    assert.deepEqual(
      report.candidateNeighborhoods?.map((group) => group.lines),
      ["2-8", "12-18"],
    );
    const context = report.candidateNeighborhoods?.flatMap((group) => group.rows).join("\n") ?? "";
    assert.ok(context.includes(`${h(before, 4)}│function primary() {`));
    assert.ok(context.includes(`${h(before, 14)}│function secondary() {`));
    assert.equal(anchorLine(context, 5), h(before, 5));
    assert.equal(await readFile(file, "utf8"), before);
    await call(edit, {
      path: file,
      edits: [{ op: "replace", anchor: anchorLine(context, 15), body: ["  return updated;"] }],
    });
    lines[14] = "  return updated;";
    assert.equal(await readFile(file, "utf8"), lines.join("\n") + "\n");
  }));

test("schema-invalid bodies omit anchor checks; subsequent retries revalidate", async () =>
  withDir(async (dir) => {
    const before = "a\nb\nc\n";
    const file = join(dir, "checks.txt");
    await writeFile(file, before);
    const edit = makeEditOverride(dir, DEFAULT_CONFIG);
    const stable = h(before, 1);
    for (const operation of [
      { op: "replace", anchor: stable, body: ["bad\nline"] },
      { op: "append", body: ["bad\nline"] },
    ]) {
      for (const laterAnchor of [h(before, 2), "2#XXXX"]) {
        await assert.rejects(
          call(edit, {
            path: file,
            edits: [operation, { op: "replace", anchor: laterAnchor, body: ["B"] }],
          }),
          (error: Error) => {
            rejectsArguments()(error);
            const report = argumentError(error);
            assert.equal(report.matched, undefined);
            assert.equal(report.failures, undefined);
            return true;
          },
        );
        assert.equal(await readFile(file, "utf8"), before);
      }
    }
    const rejected = failureReport(
      await call(edit, {
        path: file,
        edits: [
          { op: "replace", anchor: stable, body: ["A"] },
          { op: "delete", anchor: h(before, 2), end: "3#ZZZZ" },
        ],
      }),
    );
    assert.deepEqual(rejected.matched, ["edits[0].anchor", "edits[1].anchor"]);
    assert.equal(rejected.failures?.[0].field, "edits[1].end");
    assert.equal(rejected.failures?.[0].cited, "3#ZZZZ");
    assert.match(rejected.next ?? "", /Retries verify every anchor again/);
    assert.equal(await readFile(file, "utf8"), before);
    await writeFile(file, "changed\nb\nc\n");
    const retry = failureReport(
      await call(edit, {
        path: file,
        edits: [
          { op: "replace", anchor: stable, body: ["A"] },
          { op: "replace", anchor: "3#ZZZZ", body: ["B"] },
        ],
      }),
    );
    assert.ok(
      retry.failures?.some(
        (failure) => failure.field === "edits[0].anchor" && failure.cited === stable,
      ),
    );
    assert.equal(retry.matched, undefined);
    assert.equal(await readFile(file, "utf8"), "changed\nb\nc\n");
  }));

test("single-operation anchor failures omit redundant matched-anchor facts", async () =>
  withDir(async (dir) => {
    const file = join(dir, "single.txt");
    const source = "line1\nline2\nline3\n";
    await writeFile(file, source);
    const edit = makeEditOverride(dir, DEFAULT_CONFIG);
    for (const operation of [
      { op: "replace", anchor: "1#XXXX", body: ["new"] },
      { op: "replace", anchor: h(source, 1), end: "2#YYYY", body: ["new"] },
    ]) {
      const report = failureReport(await call(edit, { path: file, edits: [operation] }));
      assert.equal(report.error, "ANCHOR_MISMATCH");
      assert.equal(report.matched, undefined);
      assert.equal(report.omittedMatched, undefined);
      assert.equal(await readFile(file, "utf8"), source);
    }
  }));

test("failed batches return more than forty checks and mappings when byte budgets allow", async () =>
  withDir(async (dir) => {
    const original = "a\ntarget\nz\n";
    const before = `prefix\n${original}`;
    const file = join(dir, "many-checks.txt");
    await writeFile(file, before);
    const edits = Array.from({ length: 45 }, () => ({
      op: "replace",
      anchor: h(original, 2),
      body: ["changed"],
    }));
    const report = failureReport(
      await call(makeEditOverride(dir, DEFAULT_CONFIG), { path: file, edits }),
    );
    assert.equal(report.failures?.length, 45);
    assert.equal(report.omittedFailures, undefined);
    assert.equal(report.omittedMatched, undefined);
    assert.equal(report.matched, undefined);
    assert.ok(report.failures?.every((failure) => failure.candidate === h(before, 3)));
    assert.equal(report.failures?.filter((failure) => failure.content === "target").length, 1);
    assert.equal(await readFile(file, "utf8"), before);
  }));

test("unique candidate content is independent of oversized neighboring rows", async () =>
  withDir(async (dir) => {
    const original = "header\ntarget\ntail\n";
    const before = `header\n${"x".repeat(DEFAULT_OUTPUT_BUDGETS.blockBytes + 1)}\ntarget\ntail\n`;
    const file = join(dir, "fallback.txt");
    await writeFile(file, before);
    const report = failureReport(
      await call(makeEditOverride(dir, DEFAULT_CONFIG), {
        path: file,
        edits: [{ op: "replace", anchor: h(original, 2), body: ["updated"] }],
      }),
    );
    const candidate = report.failures?.[0].candidate;
    assert.ok(candidate);
    assert.equal(candidate, h(before, 3));
    assert.equal(report.failures?.[0].content, "target");
    assert.equal(report.candidateNeighborhoods, undefined);
    assert.equal(report.omittedFailures, undefined);
    assert.equal(await readFile(file, "utf8"), before);
    await call(makeEditOverride(dir, DEFAULT_CONFIG), {
      path: file,
      edits: [{ op: "replace", anchor: candidate, body: ["updated"] }],
    });
    assert.equal(await readFile(file, "utf8"), before.replace("target", "updated"));
  }));

test("standalone CR replacements remain visible in diffs and exact in file bytes", async () =>
  withDir(async (dir) => {
    const file = join(dir, "cr.txt");
    for (const [before, find, replacement] of [
      ["a\rb\n", "\r", "\n"],
      ["a\rb\n", "\r", "␍"],
    ]) {
      await writeFile(file, before);
      const result = await call(makeReplaceTool(dir, DEFAULT_CONFIG), {
        path: file,
        replacements: [{ find, replace: replacement, literal: false }],
      });
      assert.equal(await readFile(file, "utf8"), before.replaceAll(find, replacement));
      assert.match(result.details.diff, /^-1 a␍/m);
      assert.match(result.details.diff, /^\+1 a/m);
      assert.ok(!result.details.diff.includes("\r"));
    }
  }));

test("shifted unique candidate → displays standalone CR without altering its anchor", async () =>
  withDir(async (dir) => {
    const file = join(dir, "cr.txt");
    const before = "remove\na\rb\n";
    await writeFile(file, before);
    await call(makeEditOverride(dir, DEFAULT_CONFIG), {
      path: file,
      edits: [{ op: "delete", anchor: h(before, 1) }],
    });
    assert.equal(await readFile(file, "utf8"), "a\rb\n");
    const report = failureReport(
      await call(makeEditOverride(dir, DEFAULT_CONFIG), {
        path: file,
        edits: [{ op: "delete", anchor: h(before, 2) }],
      }),
    );
    assert.equal(report.failures?.[0].candidate, h("a\rb\n", 1));
    assert.equal(report.failures?.[0].content, "a␍b");
  }));

test("edit receives multiple wrong-length anchors → reports each location with one recovery hint", async () =>
  withDir(async (dir) => {
    const text = "first\nsecond\n";
    const file = join(dir, "f.txt");
    await writeFile(file, text);
    const { hashLen } = DEFAULT_CONFIG;
    const edit = makeEditOverride(dir, DEFAULT_CONFIG);
    const anchor = h(text, 1);
    const short = h(text, 2).slice(0, -2);
    const args = {
      path: "f.txt",
      edits: [
        { op: "replace", anchor, end: short, body: ["x"] },
        { op: "delete", anchor: short },
      ],
    };

    await assert.rejects(call(edit, args), (error: Error) => {
      rejectsArgument("edits[0].end")(error);
      rejectsArgument("edits[1].anchor")(error);
      const issues = argumentError(error).issues;
      assert.deepEqual(
        issues.map((issue) => issue.field),
        ["edits[0].end", "edits[1].anchor"],
      );
      assert.equal(issues.filter((issue) => issue.fix?.includes("Read or grep")).length, 1);
      assert.match(error.message, new RegExp(`${hashLen - 2} hash characters`));
      assert.match(error.message, new RegExp(`hashLen.*${hashLen}`));
      return true;
    });
    assert.equal(await readFile(file, "utf8"), text);
  }));

test("Pi-converted single-object edits execute as a canonical array", async () =>
  withDir(async (dir) => {
    const file = join(dir, "converted.txt");
    const original = "first\nsecond\n";
    await writeFile(file, original);
    const edit = makeEditOverride(dir, DEFAULT_CONFIG);
    const operation = { op: "replace", anchor: h(original, 2), body: ["SECOND"] };
    const args = validateToolArguments(edit as any, {
      type: "toolCall",
      id: "converted",
      name: "edit",
      arguments: { path: "converted.txt", edits: operation },
    });
    assert.deepEqual(args.edits, [operation]);
    await call(edit, args);
    assert.equal(await readFile(file, "utf8"), "first\nSECOND\n");
  }));

test("edit execute rejects legacy oldText/newText without op", async () =>
  withDir(async (dir) => {
    const file = join(dir, "f.txt");
    await writeFile(file, "first\nsecond\n");
    const edit = makeEditOverride(dir, DEFAULT_CONFIG);
    await assert.rejects(
      call(edit, {
        path: "f.txt",
        oldText: "first",
        newText: "FIRST",
      }),
      rejectsArguments(),
    );
    await assert.rejects(
      call(edit, {
        path: "f.txt",
        edits: [{ oldText: "first", newText: "FIRST" } as any],
      }),
      rejectsArguments(),
    );
    assert.equal(await readFile(file, "utf8"), "first\nsecond\n");
  }));

test("unresolved snapshot rows support direct retry and revalidate after further changes", async () => {
  await withDir(async (dir) => {
    const file = join(dir, "recover.txt");
    const observed = "\uFEFFguard\r\ntarget = old\r\n中文 literal \\n\\0\r\n";
    const current = observed.replace("old", "pending");
    await writeFile(file, current);
    const edit = makeEditOverride(dir, DEFAULT_CONFIG);
    const report = failureReport(
      await call(edit, {
        path: "recover.txt",
        edits: [{ op: "replace", anchor: h(observed, 2), body: ["target = new"] }],
      }),
    );
    const diagnostic = report.failures?.[0].observed ?? "";
    assert.match(diagnostic, /^2#[0-9A-Z]+│target = pending$/);
    assert.deepEqual(await readFile(file), Buffer.from(current));
    const retryAnchor = anchorLine(diagnostic, 2);
    const changedAgain = current.replace("pending", "other");
    await writeFile(file, changedAgain);
    const retry = failureReport(
      await call(edit, {
        path: "recover.txt",
        edits: [{ op: "replace", anchor: retryAnchor, body: ["target = new"] }],
      }),
    );
    assert.equal(retry.error, "ANCHOR_MISMATCH");
    assert.deepEqual(await readFile(file), Buffer.from(changedAgain));
    await writeFile(file, current);
    await call(edit, {
      path: "recover.txt",
      edits: [{ op: "replace", anchor: retryAnchor, body: ["target = new"] }],
    });
    assert.deepEqual(await readFile(file), Buffer.from(observed.replace("old", "new")));
  });
});
test("unresolved oversized and out-of-range rows require more context without partial anchors", async () => {
  await withDir(async (dir) => {
    const file = join(dir, "recover.txt");
    const current =
      "界".repeat(Math.ceil(DEFAULT_OUTPUT_BUDGETS.fieldBytes / Buffer.byteLength("界"))) + "\n";
    await writeFile(file, current);
    const edit = makeEditOverride(dir, DEFAULT_CONFIG);
    for (const anchor of [h("old\n", 1), "99#XXXX"]) {
      const report = failureReport(
        await call(edit, {
          path: "recover.txt",
          edits: [{ op: "replace", anchor, body: ["new"] }],
        }),
      );
      assert.match(report.next ?? "", /read or grep/);
      assert.equal(report.failures?.[0].observed, undefined);
      assert.equal(
        report.failures?.[0].omitted,
        anchor.startsWith("99#")
          ? "cited line is out of range"
          : `row exceeds ${formatByteSize(DEFAULT_OUTPUT_BUDGETS.fieldBytes)}`,
      );
      assert.deepEqual(await readFile(file), Buffer.from(current));
    }
  });
});

test("edit rejects impossible checksum characters before accessing the file", async () =>
  withDir(async (dir) => {
    const tool = makeEditOverride(dir, DEFAULT_CONFIG);
    for (const char of ["I", "L", "O", "U"]) {
      await assert.rejects(
        call(tool, {
          path: "missing.txt",
          edits: [{ op: "delete", anchor: `1#${char.repeat(DEFAULT_CONFIG.hashLen)}` }],
        }),
        rejectsArguments(),
      );
    }
  }));

test("ambiguous failure lists and neighborhoods select the same first eight candidates", async () =>
  withDir(async (dir) => {
    const positions = [4, 14, 24, 34, 44, 54, 64, 74, 84];
    const lines = Array.from({ length: 90 }, (_, index) => `line-${index + 1}`);
    for (const position of positions) lines[position - 1] = "target";
    const text = lines.join("\n");
    await writeFile(join(dir, "candidates.txt"), text);
    const tool = makeEditOverride(dir, DEFAULT_CONFIG);
    const report = failureReport(
      await call(tool, {
        path: "candidates.txt",
        edits: [{ op: "delete", anchor: `200#${computeLineHash(200, "target", 4)}` }],
      }),
    );
    assert.equal(report.failures?.[0].omittedCandidates, 1);
    assert.deepEqual(
      report.failures?.[0].candidates,
      positions.slice(0, 8).map((position) => h(text, position)),
    );
    const rows = report.candidateNeighborhoods?.flatMap((group) => group.rows) ?? [];
    for (const position of positions.slice(0, 8))
      assert.ok(rows.includes(`${h(text, position)}│target`));
    assert.ok(!JSON.stringify(report).includes(h(text, 84)));
    assert.equal(await readFile(join(dir, "candidates.txt"), "utf8"), text);
  }));

test("edit verification → uses the supplied hash length", async () =>
  withDir(async (dir) => {
    const edit = makeEditOverride(dir, { ...DEFAULT_CONFIG, hashLen: 6 });
    await writeFile(join(dir, "registered.txt"), "before\n");
    const result = await call(edit, {
      path: "registered.txt",
      edits: [
        {
          op: "replace",
          anchor: `1#${computeLineHash(1, "before", 6)}`,
          body: ["after"],
        },
      ],
    });
    assert.equal(result.isError, undefined);
    assert.equal(await readFile(join(dir, "registered.txt"), "utf8"), "after\n");
  }));

test("copy/move through read anchors → publishes captured bytes with BOM and mixed endings intact", async () =>
  withDir(async (dir) => {
    const path = "transfer.txt";
    const file = join(dir, path);
    const source = "\uFEFFA\r\nB\nC\r\nD\n";
    const read = makeReadOverride(dir, DEFAULT_CONFIG);
    const edit = makeEditOverride(dir, DEFAULT_CONFIG);
    for (const op of ["copy", "move"] as const) {
      await writeFile(file, source);
      const observed: Awaited<ReturnType<typeof read.execute>> = await callTool(read, { path });
      const rows = observed.content
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join("\n");
      const result: Awaited<ReturnType<typeof edit.execute>> = await callTool(edit, {
        path,
        edits: [
          { op, anchor: anchorLine(rows, 1), end: anchorLine(rows, 2), after: anchorLine(rows, 4) },
        ],
      });
      const expected = op === "copy" ? source + "A\r\nB\n" : "\uFEFFC\r\nD\nA\r\nB\n";
      const bytes = Buffer.from(expected, "utf8");
      assert.deepEqual(await readFile(file), bytes);
      assert.equal(result.isError, undefined);
      assert.equal(reportOf(result, "edit")?.publication, "PUBLISHED");
    }
  }));

test("copy/move stale destination → report its field and skip publication and fused commands", async () =>
  withDir(async (dir) => {
    const original = "A\nB\nC\n";
    const current = "A\nB\nNEW\n";
    const file = join(dir, "stale-transfer.txt");
    await writeFile(file, current);
    let commands = 0;
    const fusion = createActionFusionExecutor(async () => {
      commands++;
      return { status: "succeeded", result: { content: [{ type: "text", text: "ran" }] } };
    });
    const edit = makeEditOverride(dir, DEFAULT_CONFIG, fusion);
    for (const op of ["copy", "move"] as const) {
      const report = failureReport(
        await callTool(edit, {
          path: file,
          edits: [
            { op, anchor: h(current, 1), after: h(original, 3) },
            { op: "replace", anchor: h(current, 2), body: ["changed"] },
          ],
          then_run: { command: "check" },
        }),
      );
      assert.equal(report.failures?.[0].field, "edits[0].after");
      assert.equal(report.failures?.[0].cited, h(original, 3));
      assert.equal(report.then_run?.status, "skipped");
      assert.equal(report.publication, "NOT_PUBLISHED");
      assert.equal(await readFile(file, "utf8"), current);
      assert.equal(commands, 0);
    }
  }));

test("copy/move with fused command → execute after the complete transfer and preserve it on failure", async () =>
  withDir(async (dir) => {
    const source = "A\nB\nC\n";
    const file = join(dir, "fused-transfer.txt");
    for (const op of ["copy", "move"] as const) {
      await writeFile(file, source);
      const expected = op === "copy" ? "A\nB\nC\nA\n" : "B\nC\nA\n";
      let commands = 0;
      let commandBytes: string | undefined;
      const commandFailure = new Error("Command exited with code 7");
      const fusion = createActionFusionExecutor(async () => {
        commands++;
        commandBytes = await readFile(file, "utf8");
        throw commandFailure;
      });
      const edit = makeEditOverride(dir, DEFAULT_CONFIG, fusion);
      const result: Awaited<ReturnType<typeof edit.execute>> = await callTool(
        edit,
        {
          path: file,
          edits: [{ op, anchor: h(source, 1), after: h(source, 3) }],
          then_run: { command: "check" },
        },
        { ctx: { cwd: dir } },
      );
      assert.equal(reportOf(result, "edit")?.then_run?.status, "failed");
      assert.equal(reportOf(result, "edit")?.then_run?.output, commandFailure.message);
      assert.equal(commandBytes, expected);
      assert.equal(reportOf(result, "edit")?.publication, "PUBLISHED");
      assert.equal(reportOf(result, "edit")?.freshness, undefined);
      assert.equal(await readFile(file, "utf8"), expected);
      assert.equal(commands, 1);
    }
  }));
