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
import { byteRevision } from "./file-commit.ts";
import { callTool } from "./tool-call.testing.ts";
import { DEFAULT_CONFIG } from "./config.ts";
import { formatKiB, MAX_BLOCK_BYTES, MAX_RECOVERY_CANDIDATE_BYTES } from "./budgets.ts";

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
    await call(makeReadOverride(dir, DEFAULT_CONFIG), { path: "f.txt" });
    const r: any = await call(makeEditOverride(dir, DEFAULT_CONFIG), {
      path: "f.txt",
      edits: [{ op: "replace", anchor: h(text, 2), body: ["B"] }],
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

test("edit result returns Updated anchors that chain the next edit without a re-read", async () => {
  await withDir(async (dir) => {
    const f = join(dir, "f.txt");
    const text = "a\nb\nc\n";
    await writeFile(f, text);
    const edit = makeEditOverride(dir, DEFAULT_CONFIG);
    // first edit (model cites the read anchor for line 1)
    const r1: any = await call(edit, {
      path: "f.txt",
      edits: [{ op: "replace", anchor: h(text, 1), body: ["A"] }],
    });
    assert.equal(r1.isError, undefined);
    const out: string = r1.content[0].text;
    assert.match(out, /Updated anchors/);
    assert.doesNotMatch(out, /│/);
    // second edit chains on the anchor returned by the first edit — no read in between
    const r2: any = await call(edit, {
      path: "f.txt",
      edits: [{ op: "replace", anchor: anchorLine(out, 1), body: ["AA"] }],
    });
    assert.equal(r2.isError, undefined);
    assert.equal(await readFile(f, "utf-8"), "AA\nb\nc\n");
  });
});

test("edit result anchors cover an inserted block (chain an edit inside it)", async () => {
  await withDir(async (dir) => {
    const f = join(dir, "f.txt");
    const text = "a\nb\n";
    await writeFile(f, text);
    const edit = makeEditOverride(dir, DEFAULT_CONFIG);
    const r1: any = await call(edit, {
      path: "f.txt",
      edits: [{ op: "insert_after", anchor: h(text, 2), body: ["c", "d", "e"] }],
    });
    assert.equal(r1.isError, undefined);
    const out: string = r1.content[0].text;
    // line 4 (d, one of the inserted lines) must be anchored in the result
    const a4 = anchorLine(out, 4);
    const r2: any = await call(edit, {
      path: "f.txt",
      edits: [{ op: "replace", anchor: a4, body: ["DD"] }],
    });
    assert.equal(r2.isError, undefined);
    assert.equal(await readFile(f, "utf-8"), "a\nb\nc\nDD\ne\n");
  });
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
    await assert.rejects(
      call(makeEditOverride(dir, DEFAULT_CONFIG), {
        path: "f.txt",
        edits: [{ op: "replace", anchor: h(text, 2), body: ["x"] }],
      }),
      /anchor|re-read/i,
    );
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
    await assert.rejects(
      call(edit, {
        path: "recover.txt",
        edits: [{ op: "replace", anchor: h(observed, 5), body: ["updated"] }],
      }),
      (error: Error) => {
        assert.match(error.message, /Anchor mismatch: 1 unresolved/);
        assert.match(error.message, /No changes written/);
        assert.match(error.message, /Confirm.*target.*before.*anchor/);
        assert.match(error.message, /^5#[0-9A-Z]+│changed$/m);
        return true;
      },
    );
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
    await assert.rejects(
      call(makeEditOverride(dir, DEFAULT_CONFIG), {
        path: "f.txt",
        edits: [{ op: "replace", anchor: "1#XXXX", body: ["A"] }],
      }),
      /anchor|re-read/i,
    );
  });
});

test("edit execute: empty edits → throws", async () => {
  await withDir(async (dir) => {
    await writeFile(join(dir, "f.txt"), "a\n");
    await assert.rejects(
      call(makeEditOverride(dir, DEFAULT_CONFIG), { path: "f.txt", edits: [] }),
      /Validation failed for tool "edit"/,
    );
  });
});

test("edit execute: malformed op (replace without body) → throws", async () => {
  await withDir(async (dir) => {
    await writeFile(join(dir, "f.txt"), "a\n");
    await assert.rejects(
      call(makeEditOverride(dir, DEFAULT_CONFIG), {
        path: "f.txt",
        edits: [{ op: "replace", anchor: "1#XXXX" }],
      }),
      /body/i,
    );
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

// --- renderer regression guards (details.diff must be a string, renderResult must not throw) ---

const stubTheme = { fg: (_k: string, s: string) => s, bold: (s: string) => s } as Theme;

// renderResult delegates to pi's renderDiff, which reads the global TUI theme
// singleton — initialize it once for this test process (watcher off by default).
initTheme();

test("edit success: details.diff is a string (not the generateDiffString object)", async () => {
  await withDir(async (dir) => {
    const f = join(dir, "f.txt");
    const text = "a\nb\nc\n";
    await writeFile(f, text);
    await call(makeReadOverride(dir, DEFAULT_CONFIG), { path: "f.txt" });
    const r: any = await call(makeEditOverride(dir, DEFAULT_CONFIG), {
      path: "f.txt",
      edits: [{ op: "replace", anchor: h(text, 2), body: ["B"] }],
    });
    assert.equal(typeof r.details.diff, "string", "details.diff must be a string");
    assert.equal(typeof r.details.patch, "string");
    assert.equal(typeof r.details.firstChangedLine, "number");
  });
});

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
    let readCall = read.renderCall!({ path: "SKILL.md", offset: 2, limit: 3 }, stubTheme, {
      ...context,
      args: { path: "SKILL.md" },
    } as Parameters<NonNullable<typeof read.renderCall>>[2]);
    assert.match(readCall.render(120).join("\n"), /\[skill\]/);
    for (const ephemeral of [true, true, false, undefined]) {
      readCall = read.renderCall({ path: "SKILL.md", offset: 2, limit: 3, ephemeral }, stubTheme, {
        ...context,
        lastComponent: readCall,
      } as Parameters<typeof read.renderCall>[2]);
      const title = readCall.render(120).join("\n").trimEnd();
      assert.match(title, /\[skill\]/);
      assert.equal(title.endsWith(" — read once"), ephemeral === true);
      assert.equal(title.split(" — read once").length - 1, ephemeral === true ? 1 : 0);
    }
    const write = makeWriteOverride(dir);
    const writeCall = write.renderCall(
      { path: "preview.txt", content: "native content preview\n" },
      stubTheme,
      context as Parameters<typeof write.renderCall>[2],
    );
    assert.match(writeCall.render(120).join("\n"), /native content preview/);
    const error = write.renderResult(
      {
        content: [{ type: "text", text: "first error\nsecond error" }],
        details: {
          path: "preview.txt",
          created: false,
          publication: "NOT_PUBLISHED",
          publishedRevision: "r",
          observedRevision: "r",
        },
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
    await assert.rejects(call(edit, callArgs), /edits\.0\.endd: schema is false/);
    assert.equal(await readFile(join(dir, "range.txt"), "utf8"), original);
    for (const edits of [
      [],
      [{ op: "replace", anchor }],
      [{ op: "delete", anchor, body: ["bad"] }],
      [{ op: "insert_after", body: ["bad"] }],
      [{ op: "append", anchor, body: ["bad"] }],
    ]) {
      await assert.rejects(call(edit, { path: "range.txt", edits }), /Validation failed/);
      assert.equal(await readFile(join(dir, "range.txt"), "utf8"), original);
    }
    const alternates: Parameters<typeof validateToolArguments>[1]["arguments"][] = [
      { path: "range.txt", op: "replace", anchor, body: ["ok"] },
      { path: "range.txt", edits: JSON.stringify([{ op: "replace", anchor, body: ["ok"] }]) },
    ];
    for (const alternate of alternates) {
      await assert.rejects(call(edit, alternate), /Validation failed/);
      assert.equal(await readFile(join(dir, "range.txt"), "utf8"), original);
    }
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
        /Invalid argument|Invalid anchor|Validation failed for tool "edit"/,
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
          await assert.rejects(call(edit, { path, edits }), /edits\[0\]\.body: is empty/);
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
      return "ran";
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
        assert.match(error.message, /edits\[1\]\.body:.*\[""\]/);
        assert.match(error.message, /edits\[3\]\.body:.*delete/);
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

test("explicit delete removes an inclusive range and returns its successor anchor", async () =>
  withDir(async (dir) => {
    const original = "a\nb\nc\n";
    const file = join(dir, "delete_range.txt");
    await writeFile(file, original);
    const result = await call(makeEditOverride(dir, DEFAULT_CONFIG), {
      path: file,
      edits: [{ op: "delete", anchor: h(original, 1), end: h(original, 2) }],
    });
    assert.equal(await readFile(file, "utf8"), "c\n");
    assert.match(result.content[0].text, /1#[0-9A-Z]+│c/);
  }));

test("local and full-file recovery return copyable anchors without changing the rejected batch", async () =>
  withDir(async (dir) => {
    const original = "a\nb\n";
    const edit = makeEditOverride(dir, DEFAULT_CONFIG);
    for (const prefixLines of [1, 40]) {
      const prefix = "prefix\n".repeat(prefixLines);
      await writeFile(join(dir, "shift.txt"), prefix + original);
      let replacement = "";
      await assert.rejects(
        call(edit, {
          path: "shift.txt",
          edits: [{ op: "replace", anchor: h(original, 2), body: ["B"] }],
        }),
        (error: Error) => {
          replacement =
            new RegExp(`^(${prefixLines + 2}#[0-9A-Z]+)│b$`, "m").exec(error.message)?.[1] ?? "";
          assert.match(error.message, /Check the intended target/);
          assert.match(
            error.message,
            prefixLines === 1 ? /Search: local.*outside.*not checked/ : /Search: full file/,
          );
          assert.doesNotMatch(
            error.message,
            prefixLines === 1 ? /Search: full file/ : /Search: local/,
          );
          assert.doesNotMatch(error.message, /neighborhoods/);
          assert.equal((error.message.match(/^\d+#[0-9A-Z]+│/gm) ?? []).length, 1);
          return replacement !== "";
        },
      );
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
    const oversized = "x".repeat(MAX_RECOVERY_CANDIDATE_BYTES);
    const original = `a\n${oversized}\n`;
    await writeFile(join(dir, "shift-large.txt"), `prefix\n${original}`);
    const edit = makeEditOverride(dir, DEFAULT_CONFIG);
    await assert.rejects(
      call(edit, {
        path: "shift-large.txt",
        edits: [{ op: "replace", anchor: h(original, 2), body: ["B"] }],
      }),
      (error: Error) => {
        assert.match(
          error.message,
          new RegExp(`Candidate.*exceeds ${formatKiB(MAX_RECOVERY_CANDIDATE_BYTES)}`),
        );
        assert.match(error.message, /use read or grep/);
        assert.doesNotMatch(error.message, new RegExp(`│x{${oversized.length}}`));
        return true;
      },
    );
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
            replacements: [{ find: "before", replace: "after" }],
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
          const args = { path: "write.txt", content: "after\n" };
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
    ];
    for (const { path, run, expected } of cases) {
      await writeFile(join(dir, path), "before\n");
      const { result, rendered } = await run();
      assert.equal("isError" in result, false);
      assert.equal(result.details.actionFusion?.command, "failed");
      assert.equal(result.details.actionFusion?.publication, "PUBLISHED");
      if (path !== "write.txt") {
        const mutation = result.content[0];
        assert.ok(mutation.type === "text");
        assert.match(mutation.text, /^\d+#[0-9A-Z]+/m);
      }
      const last = result.content.at(-1);
      assert.ok(last?.type === "text");
      assert.match(last.text, /then_run:failed[\s\S]*command-only diagnostic/);
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
    await assert.rejects(
      call(makeReadOverride(dir, DEFAULT_CONFIG), { path: "invalid-utf8.txt" }),
      /UNSUPPORTED_ENCODING/,
    );
    await assert.rejects(
      call(makeEditOverride(dir, DEFAULT_CONFIG), {
        path: "invalid-utf8.txt",
        edits: [{ op: "append", body: ["x"] }],
      }),
      /UNSUPPORTED_ENCODING/,
    );
    await assert.rejects(
      call(makeReplaceTool(dir, DEFAULT_CONFIG), {
        path: "invalid-utf8.txt",
        replacements: [{ find: "a", replace: "b" }],
      }),
      /UNSUPPORTED_ENCODING/,
    );
    assert.deepEqual(await readFile(target), original);

    const nulTarget = join(dir, "nul.txt");
    const nulOriginal = Buffer.from([0x61, 0x00, 0x62]);
    await writeFile(nulTarget, nulOriginal);
    await assert.rejects(
      call(makeEditOverride(dir, DEFAULT_CONFIG), {
        path: "nul.txt",
        edits: [{ op: "append", body: ["x"] }],
      }),
      /UNSUPPORTED_TEXT/,
    );
    await assert.rejects(
      call(makeReplaceTool(dir, DEFAULT_CONFIG), {
        path: "nul.txt",
        replacements: [{ find: "a", replace: "b" }],
      }),
      /UNSUPPORTED_TEXT/,
    );
    assert.deepEqual(await readFile(nulTarget), nulOriginal);

    const nativeRead: any = await call(makeReadOverride(dir, DEFAULT_CONFIG), { path: "nul.txt" });
    assert.equal(nativeRead.content[0].text, "a\0b");

    const utf16Target = join(dir, "utf16.txt");
    await writeFile(utf16Target, Buffer.from([0xff, 0xfe, 0x49, 0x6c]));
    await assert.rejects(
      call(makeReadOverride(dir, DEFAULT_CONFIG), { path: "utf16.txt" }),
      /UNSUPPORTED_ENCODING/,
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
        /Validation failed for tool "edit"/,
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
      ["bad\0", /Invalid argument edits\[0\]\.body\[1\]: UNSUPPORTED_TEXT:/],
      ["\ud800", /Invalid argument edits\[0\]\.body\[1\]: INVALID_UNICODE:/],
    ] as const) {
      await assert.rejects(
        call(edit, { path: target, edits: [{ op: "append", body: ["ok", line] }] }),
        expected,
      );
      await assert.rejects(readFile(target, "utf8"), { code: "ENOENT" });
    }
  }));

test("edit preserves a UTF-8 BOM and reports bound mutation revisions", async () =>
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
      assert.equal(result.details.baseRevision, byteRevision(original));
      assert.equal(result.details.publishedRevision, byteRevision(expected));
      assert.equal(result.details.observedRevision, result.details.publishedRevision);
      assert.equal("revision" in result.details, false);
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
      /UNSUPPORTED_TEXT/,
    );
    assert.deepEqual(await readFile(target), original);
    await assert.rejects(
      call(makeReplaceTool(dir, DEFAULT_CONFIG), {
        path: "output.txt",
        replacements: [{ find: "before", replace: "bad\0text" }],
      }),
      /UNSUPPORTED_TEXT/,
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
      return "checked";
    });
    const edit = makeEditOverride(dir, DEFAULT_CONFIG, fusion);
    const stale = h(original.join("\n"), 5);
    const stable = h(before, 12);
    const candidate = h(before, 6);
    let message = "";
    await assert.rejects(
      callTool(
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
      (error: Error) => {
        message = error.message;
        return true;
      },
    );
    assert.match(message, /then_run:skipped/);
    assert.ok(message.includes(`op 0 / anchor / ${stale} / mismatched`));
    assert.ok(message.includes(`op 1 / anchor / ${stable} / matched`));
    assert.ok(message.includes(`checksum-matching candidate ${candidate}.`));
    assert.equal(message.split(`${candidate}│${original[4]}`).length - 1, 1);
    assert.doesNotMatch(message, /0 omitted|Limits:/);
    assert.doesNotMatch(message, /neighborhoods|Current-file context/);
    assert.equal((message.match(/^\d+#[0-9A-Z]+│/gm) ?? []).length, 1);
    assert.equal(await readFile(file, "utf8"), before);
    assert.equal(commands, 0);
    await callTool(
      edit,
      {
        path: file,
        edits: [
          { op: "insert_after", anchor: anchorLine(message, 6), body: ["const hashLen = 4;"] },
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
    let context = "";
    await assert.rejects(
      call(edit, {
        path: file,
        edits: [
          { op: "replace", anchor: h("header\n  return value;\n", 2), body: ["  return updated;"] },
        ],
      }),
      (error: Error) => {
        assert.match(error.message, /ambiguous checksum matches/);
        assert.match(error.message, /Search: local.*outside.*not checked/);
        assert.ok(error.message.includes(`"${h(before, 5)}" / "${h(before, 15)}"`));
        context = error.message.split("Ambiguous-candidate neighborhoods")[1];
        assert.ok(context);
        assert.match(context, /@@ candidate-neighborhood lines 2-8 @@/);
        assert.match(context, /@@ candidate-neighborhood lines 12-18 @@/);
        assert.ok(context.includes(`${h(before, 4)}│function primary() {`));
        assert.ok(context.includes(`${h(before, 14)}│function secondary() {`));
        assert.equal(anchorLine(context, 5), h(before, 5));
        return true;
      },
    );
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
            assert.match(error.message, /Validation failed for tool "edit"/);
            assert.doesNotMatch(error.message, /Input-anchor checks|\/ matched|\/ mismatched/);
            return true;
          },
        );
        assert.equal(await readFile(file, "utf8"), before);
      }
    }
    await assert.rejects(
      call(edit, {
        path: file,
        edits: [
          { op: "replace", anchor: stable, body: ["A"] },
          { op: "delete", anchor: h(before, 2), end: "3#ZZZZ" },
        ],
      }),
      (error: Error) => {
        assert.ok(error.message.includes(`op 0 / anchor / ${stable} / matched`));
        assert.match(error.message, /op 1 \/ end \/ 3#ZZZZ \/ mismatched/);
        assert.match(error.message, /Anchor checks.*retries revalidate/);
        return true;
      },
    );
    assert.equal(await readFile(file, "utf8"), before);
    await writeFile(file, "changed\nb\nc\n");
    await assert.rejects(
      call(edit, {
        path: file,
        edits: [
          { op: "replace", anchor: stable, body: ["A"] },
          { op: "replace", anchor: "3#ZZZZ", body: ["B"] },
        ],
      }),
      (error: Error) => {
        assert.ok(error.message.includes(`op 0 / anchor / ${stable} / mismatched`));
        return true;
      },
    );
    assert.equal(await readFile(file, "utf8"), "changed\nb\nc\n");
  }));

test("single-operation anchor failures omit the redundant Input-anchor checks table", async () =>
  withDir(async (dir) => {
    const file = join(dir, "single.txt");
    await writeFile(file, "line1\nline2\nline3\n");
    const edit = makeEditOverride(dir, DEFAULT_CONFIG);
    for (const operation of [
      { op: "replace", anchor: "1#XXXX", body: ["new"] },
      { op: "replace", anchor: "1#XXXX", end: "2#YYYY", body: ["new"] },
    ]) {
      await assert.rejects(call(edit, { path: file, edits: [operation] }), (error: Error) => {
        assert.match(error.message, /Anchor mismatch/);
        assert.doesNotMatch(error.message, /Input-anchor checks/);
        return true;
      });
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
    await assert.rejects(
      call(makeEditOverride(dir, DEFAULT_CONFIG), { path: file, edits }),
      (error: Error) => {
        assert.doesNotMatch(
          error.message,
          /truncated|failure details omitted|Anchor checks: \d+\/\d+/,
        );
        assert.equal(
          (error.message.match(/^op \d+ \/ anchor \/ .* \/ mismatched$/gm) ?? []).length,
          45,
        );
        assert.equal((error.message.match(/checksum-matching candidate/g) ?? []).length, 45);
        assert.equal((error.message.match(/^3#[0-9A-Z]+│target$/gm) ?? []).length, 1);
        assert.doesNotMatch(error.message, /\/ matched/);
        return true;
      },
    );
    assert.equal(await readFile(file, "utf8"), before);
  }));

test("compact edit anchors retain only untouched deletion successors in mixed batches", async () =>
  withDir(async (dir) => {
    const before = "a\nb\nc\nd\ne\nf\ng\n";
    const file = join(dir, "mixed.txt");
    await writeFile(file, before);
    const edit = makeEditOverride(dir, DEFAULT_CONFIG);
    const result = await call(edit, {
      path: file,
      edits: [
        { op: "delete", anchor: h(before, 6) },
        { op: "replace", anchor: h(before, 4), body: ["D"] },
        { op: "delete", anchor: h(before, 3) },
        { op: "replace", anchor: h(before, 1), body: ["A", "X"] },
      ],
    });
    const after = "A\nX\nb\nD\ne\ng\n";
    assert.equal(await readFile(file, "utf8"), after);
    const output = result.content[0].text;
    assert.deepEqual(
      output.split("\n").filter((line: string) => /^\d+#/.test(line)),
      [h(after, 1), h(after, 2), h(after, 4), `${h(after, 6)}│g`],
    );
    await call(edit, {
      path: file,
      edits: [{ op: "replace", anchor: anchorLine(output, 6), body: ["G"] }],
    });
    assert.equal(await readFile(file, "utf8"), "A\nX\nb\nD\ne\nG\n");
  }));

test("unique candidate content is independent of oversized neighboring rows", async () =>
  withDir(async (dir) => {
    const original = "header\ntarget\ntail\n";
    const before = `header\n${"x".repeat(MAX_BLOCK_BYTES + 1)}\ntarget\ntail\n`;
    const file = join(dir, "fallback.txt");
    await writeFile(file, before);
    let candidate = "";
    await assert.rejects(
      call(makeEditOverride(dir, DEFAULT_CONFIG), {
        path: file,
        edits: [{ op: "replace", anchor: h(original, 2), body: ["updated"] }],
      }),
      (error: Error) => {
        candidate = anchorLine(error.message, 3);
        assert.equal((error.message.match(/^3#[0-9A-Z]+│target$/gm) ?? []).length, 1);
        assert.doesNotMatch(error.message, /neighborhoods|truncated/);
        assert.equal((error.message.match(/^\d+#[0-9A-Z]+│/gm) ?? []).length, 1);
        return true;
      },
    );
    assert.equal(await readFile(file, "utf8"), before);
    await call(makeEditOverride(dir, DEFAULT_CONFIG), {
      path: file,
      edits: [{ op: "replace", anchor: candidate, body: ["updated"] }],
    });
    assert.equal(await readFile(file, "utf8"), before.replace("target", "updated"));
  }));

test("standalone CR replacements remain visible in diffs and exact in patches", async () =>
  withDir(async (dir) => {
    const file = join(dir, "cr.txt");
    for (const [before, find, replacement] of [
      ["a\rb\n", "\r", "\n"],
      ["a\rb\n", "\r", "␍"],
    ]) {
      await writeFile(file, before);
      const result = await call(makeReplaceTool(dir, DEFAULT_CONFIG), {
        path: file,
        replacements: [{ find, replace: replacement, regex: true }],
      });
      assert.equal(await readFile(file, "utf8"), before.replaceAll(find, replacement));
      assert.equal(result.details.firstChangedLine, 1);
      assert.match(result.details.diff, /^-1 a␍/m);
      assert.match(result.details.diff, /^\+1 a/m);
      assert.ok(!result.details.diff.includes("\r"));
      assert.ok(result.details.patch.includes(`-a${before.includes("\r\n") ? "\r\n" : "\rb\n"}`));
      assert.match(result.details.patch, /@@/);
    }
  }));

test("deletion successors and unique candidate rows display CR without altering anchors", async () =>
  withDir(async (dir) => {
    const file = join(dir, "cr.txt");
    const before = "remove\na\rb\n";
    await writeFile(file, before);
    const result = await call(makeEditOverride(dir, DEFAULT_CONFIG), {
      path: file,
      edits: [{ op: "delete", anchor: h(before, 1) }],
    });
    assert.ok(result.content[0].text.includes(`${h("a\rb\n", 1)}│a␍b`));
    assert.equal(await readFile(file, "utf8"), "a\rb\n");
    await assert.rejects(
      call(makeEditOverride(dir, DEFAULT_CONFIG), {
        path: file,
        edits: [{ op: "delete", anchor: h(before, 2) }],
      }),
      (error: Error) => {
        assert.ok(error.message.includes(`${h("a\rb\n", 1)}│a␍b`));
        assert.ok(!error.message.includes("\r"));
        return true;
      },
    );
  }));

test("edit tool rejects non-array formats Pi cannot convert", async () =>
  withDir(async (dir) => {
    const file = join(dir, "f.txt");
    await writeFile(file, "first\nsecond\n");
    const edit = makeEditOverride(dir, DEFAULT_CONFIG);
    const anchor = h("first\nsecond\n", 2);
    for (const alternate of [
      { path: "f.txt", edits: JSON.stringify([{ op: "replace", anchor, body: ["SECOND"] }]) },
      { path: "f.txt", op: "replace", anchor, body: ["SECOND"] },
    ]) {
      // prepareArguments only explains wrong hash lengths; it never rewrites arguments.
      assert.equal(edit.prepareArguments(alternate), alternate);
      await assert.rejects(call(edit, alternate), /Validation failed/);
      assert.equal(await readFile(file, "utf8"), "first\nsecond\n");
    }
    await call(edit, { path: "f.txt", edits: [{ op: "replace", anchor, body: ["SECOND"] }] });
    assert.equal(await readFile(file, "utf8"), "first\nSECOND\n");
  }));

test("edit names anchors whose hash length differs from the registered hashLen", async () =>
  withDir(async (dir) => {
    const text = "first\nsecond\n";
    const file = join(dir, "f.txt");
    await writeFile(file, text);
    const { hashLen } = DEFAULT_CONFIG;
    const edit = makeEditOverride(dir, DEFAULT_CONFIG);
    const anchor = h(text, 1);
    const short = h(text, 2).slice(0, -2);
    const args = { path: "f.txt", edits: [{ op: "replace", anchor, end: short, body: ["x"] }] };

    await assert.rejects(call(edit, args), (error: Error) => {
      assert.match(error.message, /Anchor hash length mismatch/);
      assert.ok(error.message.includes(`edits[0].end ${short}`));
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
      /Validation failed for tool "edit"/,
    );
    await assert.rejects(
      call(edit, {
        path: "f.txt",
        edits: [{ oldText: "first", newText: "FIRST" } as any],
      }),
      /Validation failed for tool "edit"/,
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
    let diagnostic = "";
    await assert.rejects(
      call(edit, {
        path: "recover.txt",
        edits: [{ op: "replace", anchor: h(observed, 2), body: ["target = new"] }],
      }),
      (error: Error) => {
        diagnostic = error.message;
        assert.match(diagnostic, /^2#[0-9A-Z]+│target = pending$/m);
        return true;
      },
    );
    assert.deepEqual(await readFile(file), Buffer.from(current));
    const retryAnchor = anchorLine(diagnostic, 2);
    const changedAgain = current.replace("pending", "other");
    await writeFile(file, changedAgain);
    await assert.rejects(
      call(edit, {
        path: "recover.txt",
        edits: [{ op: "replace", anchor: retryAnchor, body: ["target = new"] }],
      }),
      /Anchor mismatch/,
    );
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
      "界".repeat(Math.ceil(MAX_RECOVERY_CANDIDATE_BYTES / Buffer.byteLength("界"))) + "\n";
    await writeFile(file, current);
    const edit = makeEditOverride(dir, DEFAULT_CONFIG);
    for (const anchor of [h("old\n", 1), "99#XXXX"]) {
      await assert.rejects(
        call(edit, { path: "recover.txt", edits: [{ op: "replace", anchor, body: ["new"] }] }),
        (error: Error) => {
          assert.match(error.message, /read or grep/);
          assert.doesNotMatch(error.message, /^\d+#[0-9A-Z]+│/m);
          return true;
        },
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
        /Validation failed/,
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
    await assert.rejects(
      call(tool, {
        path: "candidates.txt",
        edits: [{ op: "delete", anchor: `200#${computeLineHash(200, "target", 4)}` }],
      }),
      (error: Error) => {
        const list = error.message
          .split("\n")
          .find((line) => line.includes("ambiguous checksum matches:"));
        assert.ok(list);
        assert.match(list, /1 more candidates omitted/);
        for (const position of positions.slice(0, 8)) {
          const anchor = h(text, position);
          assert.ok(list.includes(`"${anchor}"`));
          assert.ok(error.message.includes(`${anchor}│target`));
        }
        assert.ok(!error.message.includes(h(text, 84)));
        return true;
      },
    );
    assert.equal(await readFile(join(dir, "candidates.txt"), "utf8"), text);
  }));

test("edit verification and returned anchors use the supplied hash length", async () =>
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
    assert.equal(anchorLine(result.content[0].text, 1), `1#${computeLineHash(1, "after", 6)}`);
    assert.equal(await readFile(join(dir, "registered.txt"), "utf8"), "after\n");
  }));
