import { commandCompletion, type SessionCommand } from "./action-fusion.testing.ts";
import { argumentError } from "./argument-error.testing.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import { readFile, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { visibleWidth } from "@earendil-works/pi-tui";
import { initTheme, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { TSchema } from "typebox";
import { theme } from "../../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js";
import { makeEditOverride } from "./tool-factories.testing.ts";
import { makeReplaceTool } from "./tool-factories.testing.ts";
import { MUTATION_CARD_SHOWN, diffCardRenderers, reportLines } from "./render.ts";
import { withMutationStatus } from "./fusion-card.ts";
import { makeWriteOverride } from "./tool-factories.testing.ts";
import { generateMutationDetails } from "./mutation-result.ts";
import { createActionFusionExecutor } from "./action-fusion.ts";
import { DEFAULT_CONFIG } from "./tool-factories.testing.ts";
import { toDisplayLines } from "./grep-render.ts";
import { parseFileHeader } from "./grep-output.ts";
import { makeReadOverride } from "./tool-factories.testing.ts";
import { callTool } from "./tool-call.testing.ts";
import { renderToolError } from "./render.ts";
import { formatArgumentError } from "./argument-error.ts";
import { makeGrepOverride } from "./tool-factories.testing.ts";
import { openTestSession } from "../testing/session.testing.ts";
import type { ActionFusionProgress, Report, SuccessReport } from "./report-schema.ts";
import { renderReport } from "./report.ts";
import { MAX_CONTENT_KIB, outputBudgetsFor } from "./budgets.ts";
import { DEFAULT_OUTPUT_BUDGETS } from "./tool-factories.testing.ts";

const mutationDetails = (
  report: Pick<SuccessReport, "publication" | "freshness" | "then_run">,
) => ({
  ...generateMutationDetails("old\n", "new\n"),
  report: {
    tool: "edit" as const,
    path: "a.txt",
    ...report,
  },
});

test("empty logical diff → render according to confirmed publication state", () => {
  initTheme("dark");
  const diff = generateMutationDetails("same\r\nsame\n", "same\nsame\r\n");
  assert.equal(diff.diff, "");
  for (const publication of ["PUBLISHED", "NOT_PUBLISHED", undefined] as const) {
    const output = stripVTControlCharacters(
      diffCardRenderers("edit", "Editing…", () => "")
        .renderResult(
          {
            content: [],
            details: { ...diff, report: { tool: "edit", publication } },
          },
          { isPartial: false, expanded: true },
          theme,
          { isError: false, args: {}, state: {} },
        )
        .render(100)
        .join("\n"),
    );
    if (publication === "NOT_PUBLISHED") assert.match(output, /No net change/);
    else {
      assert.doesNotMatch(output, /No net change/);
      assert.match(output, publication === "PUBLISHED" ? /Updated/ : /No diff available/);
    }
  }
});

test("mutation headers refresh in place and retain isolated per-call counts", () => {
  initTheme("dark");
  for (const tool of [
    makeEditOverride(process.cwd(), DEFAULT_CONFIG),
    makeReplaceTool(process.cwd(), DEFAULT_CONFIG),
  ]) {
    const args = {
      path: "a.txt",
      steps: [{ action: "append" as const, lines: ["new"] }],
      replacements: [{ literal: true, find: "old", replace: "new" }],
    };
    const context: any = {
      args,
      state: {},
      invalidate() {
        assert.fail("rendering must not invalidate the row");
      },
    };
    const header = tool.renderCall(args, theme, context);
    const other = tool.renderCall({ ...args, path: "b.txt" }, theme, { ...context, state: {} });
    assert.equal(context.state.callText, header);
    tool.renderResult(
      {
        content: [{ type: "text", text: "Done" }],
        details: generateMutationDetails("old\n", "new\n"),
      },
      { isPartial: false, expanded: false },
      theme,
      context,
    );
    assert.match(header.render(100).join("\n"), /\+1/);
    assert.match(header.render(100).join("\n"), /-1/);
    assert.doesNotMatch(other.render(100).join("\n"), /\+1|-1/);
    context.lastComponent = header;
    assert.equal(tool.renderCall(args, theme, context), header);
    assert.match(header.render(100).join("\n"), /\+1/);
  }
});

test("partial edit actions → refresh per-action counts", () => {
  initTheme("dark");
  const tool = makeEditOverride(process.cwd(), DEFAULT_CONFIG);
  const steps = [
    { action: "replace", anchor: "1#AB", lines: ["new"] },
    { action: "append", lines: ["more"] },
    { action: "replace", anchor: "3#CD", lines: ["changed"] },
    { action: "delete", anchor: "5#EF" },
    { action: "insert_before", anchor: "7#GH", lines: ["before"] },
    { action: "insert_after", anchor: "9#JK", lines: ["after"] },
    { action: "prepend", lines: ["first"] },
  ];
  let header: ReturnType<typeof tool.renderCall> | undefined;
  const context = { state: {} } as Parameters<typeof tool.renderCall>[2];
  const render = (value: unknown) => {
    header = tool.renderCall(
      // Streaming arguments reach the renderer before schema validation.
      { path: "f.txt", steps: value } as Parameters<typeof tool.renderCall>[0],
      theme,
      { ...context, lastComponent: header },
    );
    return header.render(240).join("\n");
  };
  assert.match(render([steps[0], {}]), /unknown ×1/);
  const mixed = render(steps);
  assert.match(mixed, /7 ops:/);
  for (const [kind, count] of [
    ["replace", 2],
    ["delete", 1],
    ["insert_before", 1],
    ["insert_after", 1],
    ["append", 1],
    ["prepend", 1],
  ]) {
    assert.ok(mixed.includes(`${kind} ×${count}`), mixed);
  }
  assert.doesNotMatch(mixed, /unknown/);
  const single = render([steps[0]]);
  assert.match(single, /1 op: replace ×1/);
  assert.doesNotMatch(single, /append|delete|insert_before|insert_after|prepend/);
  assert.match(
    render([null, { action: "rep" }, { action: "__proto__" }, { action: { toString: null } }]),
    /4 ops: unknown ×4/,
  );
  for (const invalid of [[], undefined, JSON.stringify(steps), "[{bad"]) {
    assert.doesNotMatch(render(invalid), /ops?:/);
  }
});

test("missing or empty mutation path → show a themed placeholder until the path arrives", () => {
  initTheme("dark");
  for (const tool of [
    makeEditOverride(process.cwd(), DEFAULT_CONFIG),
    makeReplaceTool(process.cwd(), DEFAULT_CONFIG),
  ]) {
    const context = { state: {} } as Parameters<
      ReturnType<typeof makeEditOverride>["renderCall"]
    >[2] &
      Parameters<ReturnType<typeof makeReplaceTool>["renderCall"]>[2];
    let header: ReturnType<typeof tool.renderCall> | undefined;
    for (const path of [undefined, "", "f.txt"]) {
      // Streaming arguments may contain operations before the path arrives.
      const args = { path, steps: [], replacements: [] } as Parameters<
        ReturnType<typeof makeEditOverride>["renderCall"]
      >[0] &
        Parameters<ReturnType<typeof makeReplaceTool>["renderCall"]>[0];
      const previous = header;
      header = tool.renderCall(args, theme, { ...context, lastComponent: header });
      if (previous) assert.equal(header, previous);
      const output = header.render(100).join("\n");
      assert.ok(output.includes(theme.fg(path ? "accent" : "toolOutput", path || "...")));
      assert.ok(stripVTControlCharacters(output).startsWith(`${tool.name} ${path || "..."}`));
    }
  }
});

test("mutation card owns stale-anchor notices without internal status", () => {
  initTheme("dark");
  const tool = withMutationStatus(makeEditOverride(process.cwd(), DEFAULT_CONFIG));
  const args = { path: "a.txt", steps: [{ action: "append" as const, lines: ["new"] }] };
  const context: any = { args, state: {}, isPartial: false, isError: false, invalidate() {} };
  const card = tool.renderCall!(args, theme, context);
  tool.renderResult!(
    {
      content: [
        { type: "text", text: "Edit saved." },
        { type: "text", text: "command diagnostic" },
      ],
      details: mutationDetails({
        publication: "PUBLISHED",
        freshness: "changed",
        then_run: { status: "failed" },
      }),
    },
    { isPartial: false, expanded: false },
    theme,
    context,
  );
  const output = card.render(160).join("\n");
  assert.match(output, /new/);
  assert.doesNotMatch(stripVTControlCharacters(output), /(?:^|\n)\s*publication:/);
  assert.match(stripVTControlCharacters(output), /freshness: changed/);
  assert.doesNotMatch(output, /command diagnostic/);
  assert.ok(output.includes(theme.getBgAnsi("toolSuccessBg")));
});

test("mutation card omits status when then_run was not requested", () => {
  initTheme("dark");
  const tool = withMutationStatus(makeEditOverride(process.cwd(), DEFAULT_CONFIG));
  const args = { path: "a.txt", steps: [{ action: "append" as const, lines: ["new"] }] };
  const context: any = { args, state: {}, isPartial: false, isError: false, invalidate() {} };
  const card = tool.renderCall!(args, theme, context);
  tool.renderResult!(
    {
      content: [{ type: "text", text: "Edited a.txt." }],
      details: mutationDetails({
        publication: "PUBLISHED",
      }),
    },
    { isPartial: false, expanded: false },
    theme,
    context,
  );
  const output = card.render(160).join("\n");
  assert.match(output, /new/);
  assert.doesNotMatch(stripVTControlCharacters(output), /(?:^|\n)\s*(?:publication|freshness):/);
  tool.renderCall!(args, theme, context);
  tool.renderResult!(
    {
      content: [{ type: "text", text: "Edited a.txt." }],
      details: mutationDetails({
        publication: "PUBLISHED",
        freshness: "changed",
      }),
    },
    { isPartial: false, expanded: false },
    theme,
    context,
  );
  const staleOutput = card.render(160).join("\n");
  assert.match(stripVTControlCharacters(staleOutput), /freshness: changed/);
  assert.doesNotMatch(stripVTControlCharacters(staleOutput), /(?:^|\n)\s*publication:/);
});

test("unfused write errors retain the native full diagnostic", () => {
  initTheme("dark");
  const tool = withMutationStatus(makeWriteOverride(process.cwd()));
  const args = { path: "a.txt", content: "new", mode: "overwrite" as const };
  const diagnostic = "write failed\nimportant detail";
  const context: any = { args, state: {}, isPartial: false, isError: true, invalidate() {} };
  const card = tool.renderCall!(args, theme, context);
  tool.renderResult!(
    {
      content: [{ type: "text", text: diagnostic }],
      details: {
        report: {
          tool: "write",
          error: "FILESYSTEM_ERROR",
          publication: "NOT_PUBLISHED",
          message: diagnostic,
        },
      },
    },
    { isPartial: false, expanded: false },
    theme,
    context,
  );
  assert.match(card.render(160).join("\n"), /write failed[\s\S]*important detail/);
});

test("mutation previews hide CRLF boundaries even with mixed endings or an unterminated last line", () => {
  initTheme("dark");
  for (const before of ["old\r\ncontext\r\n", "old\r\ncontext\nlast", "old\r\ncontext\r\nlast"]) {
    const after = before.replace("old", "new");
    const details = generateMutationDetails(before, after);
    for (const tool of [
      makeEditOverride(process.cwd(), DEFAULT_CONFIG),
      makeReplaceTool(process.cwd(), DEFAULT_CONFIG),
    ]) {
      for (const expanded of [false, true]) {
        const context: any = { args: { path: "a.txt" }, state: {}, isError: false };
        const rendered = tool.renderResult(
          { content: [{ type: "text", text: "Done" }], details },
          { isPartial: false, expanded },
          theme,
          context,
        );
        const output = rendered.render(160).join("\n");
        assert.doesNotMatch(output, /␍/);
        assert.match(output, /old[\s\S]*new[\s\S]*context/);
      }
    }
  }
});

test("diff previews retain standalone CR and literal control-picture characters", () => {
  initTheme("dark");
  for (const before of ["old\r", "old␍", "old\rcontent\r\n"]) {
    const details = generateMutationDetails(before, before.replace("old", "new"));
    const tool = makeEditOverride(process.cwd(), DEFAULT_CONFIG);
    const result = tool.renderResult(
      { content: [], details },
      { expanded: true, isPartial: false },
      theme,
      {
        args: { path: "a.txt", steps: [{ action: "append", lines: ["new"] }] },
        state: {},
        isError: false,
      } as Parameters<typeof tool.renderResult>[3],
    );
    assert.match(result.render(160).join("\n"), /␍/);
  }
  const preview = diffCardRenderers("edit", "Editing…", () => "").renderResult(
    { content: [], details: { diff: "-1 old␍\n+1 new␍" } },
    { isPartial: false, expanded: true },
    theme,
    { isError: false, args: {}, state: {} },
  );
  assert.match(preview.render(160).join("\n"), /␍/);
});

test("150,000 rows in one grep group → renders every row with shared indentation folded", () => {
  initTheme("dark");
  const rowCount = 150_000;
  const header = `many.txt · ${rowCount} matches`;
  const raw = [
    header,
    ...Array.from(
      { length: rowCount },
      (_, index) => `${index + 1}#ABCD│${index === 0 ? "    " : "  "}hit`,
    ),
  ].join("\n");
  const lines = toDisplayLines(raw, theme).map(stripVTControlCharacters);
  assert.equal(lines.length, rowCount + 1);
  assert.equal(lines[0], header);
  const width = String(rowCount).length;
  assert.equal(lines[1], `   ${"1".padStart(width)}: ›   hit`);
  assert.equal(lines[2], `   ${"2".padStart(width)}: › hit`);
  assert.equal(lines.at(-1), `   ${rowCount}: › hit`);
});

test("Unicode line separators in grep paths → parses the full file header", async (t) => {
  for (const separator of ["\u2028", "\u2029"]) {
    await t.test(JSON.stringify(separator), () => {
      const path = `before${separator}after.txt`;
      assert.deepEqual(parseFileHeader(`${path} · 2 matches`), { path, summary: "2 matches" });
    });
  }
});

test("grep files mode with header-like and anchor-like names → preserves complete paths", () => {
  initTheme("dark");
  const tool = makeGrepOverride(process.cwd(), DEFAULT_CONFIG);
  const paths = ["a · 1 match", "1#ABCD│name"];
  const rendered = tool.renderResult(
    { content: [{ type: "text", text: paths.join("\n") }], details: undefined },
    { isPartial: false, expanded: true },
    theme,
    {
      args: { pattern: ["needle"], literal: true, outputMode: "files" },
      toolCallId: "test",
      invalidate() {},
      lastComponent: undefined,
      state: {},
      cwd: process.cwd(),
      executionStarted: true,
      argsComplete: true,
      isPartial: false,
      expanded: true,
      showImages: false,
      isError: false,
    },
  );
  const lines = rendered.render(120).map((line) => stripVTControlCharacters(line).trimEnd());
  for (const path of paths) assert.ok(lines.includes(path), JSON.stringify(lines));
});

test("grep renders anchored and plain groups with shared width and folded indentation", () => {
  initTheme("dark");
  const raw = [
    "valid.ts · 2 matches",
    "9#ABCD│  alpha",
    "10#ABCD│    beta",
    "",
    "invalid.txt · 2 matches",
    "100│\tbad �",
    "7│\t\tother",
  ].join("\n");
  assert.deepEqual(toDisplayLines(raw, theme), [
    theme.fg("success", "valid.ts") + theme.fg("dim", " · 2 matches"),
    theme.fg("dim", "     9: ") + theme.fg("dim", "›") + " " + theme.fg("toolOutput", "alpha"),
    theme.fg("dim", "    10: ") + theme.fg("dim", "›") + " " + theme.fg("toolOutput", "  beta"),
    theme.fg("toolOutput", ""),
    theme.fg("success", "invalid.txt") + theme.fg("dim", " · 2 matches"),
    theme.fg("dim", "   100: ") + theme.fg("dim", "›") + " " + theme.fg("toolOutput", "bad �"),
    theme.fg("dim", "     7: ") + theme.fg("dim", "›") + " " + theme.fg("toolOutput", "\tother"),
  ]);
});

test("grep renders plain and anchored rows in one group without exposing hashes", () => {
  initTheme("dark");
  const raw = "mixed.txt · 2 matches\n1#ABCD│alpha\n12│  7#ABCD│literal content";
  assert.deepEqual(toDisplayLines(raw, theme), [
    theme.fg("success", "mixed.txt") + theme.fg("dim", " · 2 matches"),
    theme.fg("dim", "    1: ") + theme.fg("toolOutput", "alpha"),
    theme.fg("dim", "   12: ") + theme.fg("toolOutput", "  7#ABCD│literal content"),
  ]);
});

test("all tools render argument issues as field diagnostics while preserving model JSON", async () => {
  initTheme("dark");
  const cwd = process.cwd();
  const tools = [
    makeReadOverride(cwd, DEFAULT_CONFIG),
    withMutationStatus(makeEditOverride(cwd, DEFAULT_CONFIG)),
    withMutationStatus(makeReplaceTool(cwd, DEFAULT_CONFIG)),
    withMutationStatus(makeWriteOverride(cwd)),
    makeGrepOverride(cwd, DEFAULT_CONFIG),
  ];
  for (const tool of tools) {
    for (const fused of [false, true]) {
      const args = {
        path: tool.name === "grep" ? ["unused.txt"] : "unused.txt",
        content: "unused",
        mode: "create" as const,
        steps: [{ action: "append" as const, lines: ["unused"] }],
        replacements: [{ literal: true, find: "unused", replace: "unused" }],
        pattern: ["unused"],
        literal: true,
        unexpected: true,
        ...(fused ? { then_run: { command: "must-not-run" } } : {}),
      };
      let errorText = "";
      await assert.rejects(callTool(tool, args), (error: unknown) => {
        assert.ok(error instanceof Error);
        errorText = error.message;
        return true;
      });
      const issues = argumentError(new Error(errorText)).issues;
      assert.ok(issues.length > 0);
      for (const expanded of [false, true]) {
        const context = {
          args,
          state: {},
          toolCallId: "validation",
          invalidate() {},
          lastComponent: undefined,
          cwd,
          executionStarted: true,
          argsComplete: true,
          isPartial: false,
          expanded,
          showImages: false,
          isError: true,
        };
        // Pi passes unvalidated arguments to renderers after erasing their tool-specific types.
        const renderCall = tool.renderCall as ToolDefinition<TSchema>["renderCall"];
        const call = renderCall?.(args, theme, context);
        // Pi supplies no tool-specific details when argument validation fails.
        const renderError = tool.renderResult as NonNullable<
          ToolDefinition<TSchema, undefined>["renderResult"]
        >;
        const result = renderError(
          { content: [{ type: "text", text: errorText }], details: undefined },
          { isPartial: false, expanded },
          theme,
          context,
        );
        const card = tool.renderShell === "self" ? call : result;
        assert.ok(card);
        const displayed = stripVTControlCharacters(card.render(200).join("\n"));
        assert.match(displayed, /Invalid arguments/);
        assert.ok(displayed.includes(`${tool.name} not executed`));
        assert.doesNotMatch(displayed, /"error":|"issues":|"field":|"reason":/);
        assert.deepEqual(argumentError(new Error(errorText)).issues, issues);
        for (const value of [issues[0].field, issues[0].reason]) {
          assert.ok(displayed.includes(value), `${tool.name} hid the first validation issue`);
        }
        if (expanded) {
          assert.match(displayed, /unexpected: is not allowed/);
          assert.doesNotMatch(displayed, /Prepared arguments/);
        }
      }
    }
  }
});

test("expanded errors retain every text block while collapsed errors stay bounded", () => {
  initTheme("dark");
  const diagnosticLineCount = 80;
  const result = {
    content: [
      { type: "text" as const, text: "Error header\n" + "context\n".repeat(diagnosticLineCount) },
      { type: "text" as const, text: "Final cause: permission denied" },
    ],
  };
  const collapsed = renderToolError(result, "edit", theme, false).render(120).join("\n");
  const expanded = renderToolError(result, "edit", theme, true).render(120).join("\n");
  assert.match(collapsed, /Error header/);
  assert.doesNotMatch(collapsed, /Final cause/);
  assert.match(expanded, /Final cause: permission denied/);
  assert.ok(collapsed.split("\n").length < expanded.split("\n").length);
});

test("argument cards preserve omission notices and all expanded issues", () => {
  initTheme("dark");
  const issues = Array.from({ length: 200 }, (_, index) => ({
    field: `steps[${index}].lines`,
    reason: `中文🙂 ${index}: supply a line.\n${"context ".repeat(50)}\nFinal cause: empty body.`,
  }));
  const diagnostic = formatArgumentError(issues, true, DEFAULT_OUTPUT_BUDGETS);
  const parsed = argumentError(new Error(diagnostic));
  assert.ok(parsed.schemaLimited && parsed.omittedIssues);
  const result = {
    content: [{ type: "text" as const, text: diagnostic }],
  };
  const original = structuredClone(result);
  const collapsed = stripVTControlCharacters(
    renderToolError(result, "edit", theme, false).render(100).join("\n"),
  );
  const expanded = stripVTControlCharacters(
    renderToolError(result, "edit", theme, true).render(100).join("\n"),
  );
  for (const displayed of [collapsed, expanded]) {
    assert.match(displayed, /Schema diagnostic limit/);
    assert.ok(displayed.includes(`${parsed.omittedIssues} issues omitted`));
    assert.doesNotMatch(displayed, /"error":|"issues":/);
  }
  for (const issue of parsed.issues) assert.ok(expanded.includes(issue.field));
  assert.match(expanded, /Final cause: empty body/);
  assert.ok(collapsed.split("\n").length < expanded.split("\n").length);
  assert.deepEqual(result, original);
});

test("unrecognized or malformed JSON errors retain their original diagnostic", () => {
  initTheme("dark");
  for (const diagnostic of [
    "",
    '{"error":"OTHER_ERROR","cause":"permission denied"}',
    '{"error":"INVALID_ARGUMENTS","executed":true,"issues":[]}',
    '{"error":"INVALID_ARGUMENTS","tool":"edit","executed":false,"issues":[{"field":"path","reason":null}]}',
    '{"error":"INVALID_ARGUMENTS",',
    "Filesystem failure: permission denied",
  ]) {
    const result = { content: [{ type: "text" as const, text: diagnostic }] };
    const displayed = stripVTControlCharacters(
      renderToolError(result, "edit", theme, true).render(300).join("\n"),
    );
    assert.ok(displayed.includes(diagnostic || "Error"));
  }
});

test("argument diagnostics wrap Unicode and multiline reasons at narrow terminal widths", () => {
  const field = "steps[0].lines";
  const reason = '中文🙂: supply at least one line.\nUse ["空行"] for this example.';
  const diagnostic = formatArgumentError([{ field, reason }], false, DEFAULT_OUTPUT_BUDGETS);
  const result = { content: [{ type: "text" as const, text: diagnostic }] };
  for (const appearance of ["dark", "light"] as const) {
    initTheme(appearance);
    for (const width of [24, 80]) {
      for (const expanded of [false, true]) {
        const lines = renderToolError(result, "edit", theme, expanded).render(width);
        assert.ok(lines.every((line) => visibleWidth(line) <= width));
        const displayed = stripVTControlCharacters(lines.join("\n")).replace(/\s/g, "");
        for (const value of [field, reason, "edit not executed"]) {
          assert.ok(displayed.includes(value.replace(/\s/g, "")));
        }
      }
    }
  }
  initTheme("dark");
});

test("command changes or removes the target → completed mutation stays successful with a freshness warning", async (t) => {
  initTheme("dark");
  const { cwd, session } = await openTestSession(t, { tools: [] });
  for (const disturbance of ["changed", "missing"] as const) {
    const path = `${disturbance}.txt`;
    const target = join(cwd, path);
    const executeTool: SessionCommand = async () => {
      assert.equal(await readFile(target, "utf8"), "saved\n");
      if (disturbance === "changed") await writeFile(target, "command changed the file\n");
      else await unlink(target);
      return commandCompletion({ content: [{ type: "text", text: "checked" }] });
    };
    const fusion = createActionFusionExecutor(() => {});
    const tool = withMutationStatus(makeWriteOverride(cwd, fusion));
    const args = {
      path,
      mode: "create" as const,
      content: "saved\n",
      then_run: { command: "check target" },
    };
    const context: Parameters<NonNullable<typeof tool.renderCall>>[2] = {
      args,
      toolCallId: disturbance,
      cwd,
      state: {},
      lastComponent: undefined,
      invalidate() {},
      executionStarted: true,
      argsComplete: true,
      isPartial: true,
      expanded: false,
      showImages: false,
      isError: false,
    };
    const card = tool.renderCall!(args, theme, context);
    // Pi erases result types for rendering; initial progress has no commit fields yet.
    const renderResult = tool.renderResult as NonNullable<
      ToolDefinition<TSchema, unknown>["renderResult"]
    >;
    const completedFrames: string[] = [];
    const result = await callTool(tool, args, {
      toolCallId: disturbance,
      ctx: { ...session.extensionRunner.createToolContext(disturbance, undefined), executeTool },
      onUpdate: (update: AgentToolResult<{ actionFusion: ActionFusionProgress }>) => {
        tool.renderCall!(args, theme, context);
        renderResult(update, { isPartial: true, expanded: false }, theme, context);
        if (update.details.actionFusion.mutationCompleted)
          completedFrames.push(card.render(160).join("\n"));
      },
    });
    assert.ok(completedFrames.length > 0);
    assert.ok(completedFrames.every((frame) => frame.includes(theme.getBgAnsi("toolSuccessBg"))));
    context.isPartial = false;
    tool.renderCall!(args, theme, context);
    renderResult(result, { isPartial: false, expanded: false }, theme, context);
    const output = card.render(160).join("\n");
    assert.ok(output.includes(theme.getBgAnsi("toolSuccessBg")));
    assert.match(stripVTControlCharacters(output), new RegExp(`freshness: ${disturbance}`));
    if (disturbance === "changed")
      assert.equal(await readFile(target, "utf8"), "command changed the file\n");
    else await assert.rejects(readFile(target), { code: "ENOENT" });
  }
});

test("success renderers receive replayed or hooked reports → display only schema-checked facts", () => {
  initTheme("dark");
  const cwd = process.cwd();
  const cases = [
    { name: "grep" as const, tool: makeGrepOverride(cwd, DEFAULT_CONFIG) },
    { name: "read" as const, tool: makeReadOverride(cwd, DEFAULT_CONFIG) },
    { name: "read" as const, tool: makeReadOverride(cwd, DEFAULT_CONFIG), nativeRead: true },
    { name: "write" as const, tool: makeWriteOverride(cwd) },
    { name: "edit" as const, tool: makeEditOverride(cwd, DEFAULT_CONFIG) },
    { name: "replace" as const, tool: makeReplaceTool(cwd, DEFAULT_CONFIG) },
  ];
  for (const { name, tool, nativeRead } of cases) {
    // Pi renders persisted or hooked details with their result type erased.
    const render = tool.renderResult as NonNullable<
      ToolDefinition<TSchema, unknown>["renderResult"]
    >;
    const context: Parameters<typeof render>[3] = {
      args: { path: "a.txt" },
      state: {},
      cwd,
      toolCallId: `${tool.name}-${nativeRead ?? false}`,
      lastComponent: undefined,
      invalidate() {},
      executionStarted: true,
      argsComplete: true,
      isPartial: false,
      expanded: true,
      showImages: false,
      isError: false,
    };
    const show = (report: unknown, text: string) => {
      const result = {
        content: [{ type: "text" as const, text }],
        details: { nativeRead, report },
      };
      const before = structuredClone(result);
      const output = stripVTControlCharacters(
        render(result, { isPartial: false, expanded: true }, theme, context).render(240).join("\n"),
      );
      assert.deepEqual(result, before);
      return output;
    };
    const payload = (text: string) =>
      name === "read" && !nativeRead ? `a.txt · 1 lines\n1#ABCD│${text}` : text;
    const report: SuccessReport = { tool: name, next: "CHECKED_REPORT_RECOVERY" };
    const checked = show(report, renderReport(report));
    assert.doesNotMatch(checked, /"next"/);
    if (!nativeRead) assert.match(checked, /next: CHECKED_REPORT_RECOVERY/);
    else assert.doesNotMatch(checked, /CHECKED_REPORT_RECOVERY/);
    for (const invalid of [
      undefined,
      null,
      "foreign report",
      { ...report, tool: "foreign", next: "UNTRUSTED_REPORT_FACT" },
      { ...report, foreign: true, next: "UNTRUSTED_REPORT_FACT" },
      { ...report, then_run: { status: "foreign" }, next: "UNTRUSTED_REPORT_FACT" },
    ]) {
      const output = show(invalid, payload("VISIBLE_PAYLOAD"));
      assert.doesNotMatch(output, /UNTRUSTED_REPORT_FACT|CHECKED_REPORT_RECOVERY/);
      if (name === "write") assert.equal(output, "");
      else
        assert.match(
          output,
          name === "edit" || name === "replace" ? /No diff available/ : /VISIBLE_PAYLOAD/,
        );
    }
    if (tool.name === "grep" || tool.name === "read") {
      const foreign = '{"hook":"VISIBLE_JSON"}';
      assert.ok(show(report, payload(foreign)).includes(foreign));
    }
  }
});

test("report text has many short lines within the byte budget → renders every diagnostic line", async (t) => {
  initTheme("dark");
  const newlineCount = 150_000;
  const message = `first${"\n".repeat(newlineCount)}last`;
  assert.ok(Buffer.byteLength(message) < outputBudgetsFor(MAX_CONTENT_KIB * 1024).fieldBytes);
  const cases: readonly { name: string; report: Report; lines: number }[] = [
    {
      name: "failure message",
      report: { tool: "read", error: "UNCLASSIFIED", message },
      lines: newlineCount + 2,
    },
    {
      name: "search diagnostic",
      report: { tool: "grep", diagnostics: message },
      lines: newlineCount + 1,
    },
    {
      name: "argument reason",
      report: {
        tool: "edit",
        error: "INVALID_ARGUMENTS",
        issues: [{ field: "path", reason: message }],
      },
      lines: newlineCount + 2,
    },
  ];
  for (const entry of cases) {
    await t.test(entry.name, () => {
      const lines = reportLines(entry.report, theme).map(stripVTControlCharacters);
      assert.equal(lines.length, entry.lines);
      assert.ok(lines.some((line) => line.includes("first")));
      assert.equal(lines.at(-1)?.trim(), "last");
    });
  }
});

test("TUI-only mutation facts render on the card while model serialization omits them", () => {
  initTheme("dark");
  const report: Report = {
    tool: "edit",
    path: "a.txt",
    publication: "PUBLISHED",
    progressError: { message: "display unavailable" },
  };
  const output = stripVTControlCharacters(
    reportLines(report, theme, MUTATION_CARD_SHOWN).join("\n"),
  );
  assert.match(output, /progressError/);
  assert.match(output, /display unavailable/);
  assert.doesNotMatch(renderReport(report), /progressError|display unavailable/);
});
