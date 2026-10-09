import { argumentError } from "./argument-error.testing.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import { visibleWidth } from "@earendil-works/pi-tui";
import {
  generateDiffString,
  initTheme,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { TSchema } from "typebox";
import { theme } from "../../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js";
import { displayCarriageReturns } from "./anchor-format.ts";
import { makeEditOverride } from "./edit-tool.ts";
import { makeReplaceTool } from "./replace-tool.ts";
import { renderDiffPreview } from "./render.ts";
import { withMutationStatus } from "./fusion-card.ts";
import { makeWriteOverride } from "./write-tool.ts";
import { generateMutationDetails } from "./mutation-result.ts";
import type { ActionFusionDetails } from "./action-fusion.ts";
import { DEFAULT_CONFIG } from "./config.ts";
import { toDisplayLines } from "./grep-render.ts";
import { makeReadOverride } from "./read-tool.ts";
import { callTool } from "./tool-call.testing.ts";
import { renderToolError } from "./render.ts";
import { formatArgumentError } from "./argument-error.ts";
import { makeGrepOverride } from "./grep-tool.ts";
import { registerForgetTool } from "./forget-tool.ts";
import { openTestSession } from "../testing/session.testing.ts";

const versions = { publishedRevision: "r", observedRevision: "r" };
const mutationDetails = (actionFusion?: ActionFusionDetails) => ({
  ...generateMutationDetails("a.txt", "same\n", "same\n", versions, "PUBLISHED"),
  actionFusion,
});

test("mutation headers refresh in place and retain isolated per-call counts", () => {
  initTheme("dark");
  for (const tool of [
    makeEditOverride(process.cwd(), DEFAULT_CONFIG),
    makeReplaceTool(process.cwd(), DEFAULT_CONFIG),
  ]) {
    const args = {
      path: "a.txt",
      edits: [{ op: "append" as const, body: ["new"] }],
      replacements: [{ find: "old", replace: "new" }],
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
        details: generateMutationDetails("a.txt", "old\n", "new\n", versions, "PUBLISHED"),
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

test("edit call titles count each operation type and refresh with partial input", () => {
  initTheme("dark");
  const tool = makeEditOverride(process.cwd(), DEFAULT_CONFIG);
  const edits = [
    { op: "replace", anchor: "1#AB", body: ["new"] },
    { op: "append", body: ["more"] },
    { op: "replace", anchor: "3#CD", body: ["changed"] },
    { op: "delete", anchor: "5#EF" },
    { op: "insert_before", anchor: "7#GH", body: ["before"] },
    { op: "insert_after", anchor: "9#JK", body: ["after"] },
    { op: "prepend", body: ["first"] },
    { op: "copy", anchor: "1#AB", before: "3#CD" },
    { op: "move", anchor: "3#CD", after: "5#EF" },
  ];
  let header: ReturnType<typeof tool.renderCall> | undefined;
  const context = { state: {} } as Parameters<typeof tool.renderCall>[2];
  const render = (value: unknown) => {
    header = tool.renderCall(
      // Streaming arguments reach the renderer before schema validation.
      { path: "f.txt", edits: value } as Parameters<typeof tool.renderCall>[0],
      theme,
      { ...context, lastComponent: header },
    );
    return header.render(240).join("\n");
  };
  assert.match(render([edits[0], {}]), /unknown ×1/);
  const mixed = render(edits);
  assert.match(mixed, /9 ops:/);
  for (const [kind, count] of [
    ["replace", 2],
    ["delete", 1],
    ["copy", 1],
    ["move", 1],
    ["insert_before", 1],
    ["insert_after", 1],
    ["append", 1],
    ["prepend", 1],
  ]) {
    assert.ok(mixed.includes(`${kind} ×${count}`), mixed);
  }
  assert.doesNotMatch(mixed, /unknown/);
  const single = render([edits[0]]);
  assert.match(single, /1 op: replace ×1/);
  assert.doesNotMatch(single, /append|copy|delete|insert_before|insert_after|move|prepend/);
  assert.match(
    render([null, { op: "rep" }, { op: "__proto__" }, { op: { toString: null } }]),
    /4 ops: unknown ×4/,
  );
  for (const invalid of [[], undefined, JSON.stringify(edits), "[{bad"]) {
    assert.doesNotMatch(render(invalid), /ops?:/);
  }
});

test("mutation card owns stale-anchor notices without internal status", () => {
  initTheme("dark");
  const tool = withMutationStatus(makeEditOverride(process.cwd(), DEFAULT_CONFIG));
  const args = { path: "a.txt", edits: [{ op: "append" as const, body: ["new"] }] };
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
        command: "failed",
      }),
    },
    { isPartial: false, expanded: false },
    theme,
    context,
  );
  const output = card.render(160).join("\n");
  assert.match(output, /Edit saved/);
  assert.doesNotMatch(output, /publication=|freshness=/);
  assert.match(output, /Anchors are stale: target changed/);
  assert.doesNotMatch(output, /command diagnostic/);
  assert.ok(output.includes(theme.getBgAnsi("toolSuccessBg")));
});

test("mutation card omits status when then_run was not requested", () => {
  initTheme("dark");
  const tool = withMutationStatus(makeEditOverride(process.cwd(), DEFAULT_CONFIG));
  const args = { path: "a.txt", edits: [{ op: "append" as const, body: ["new"] }] };
  const context: any = { args, state: {}, isPartial: false, isError: false, invalidate() {} };
  const card = tool.renderCall!(args, theme, context);
  tool.renderResult!(
    {
      content: [{ type: "text", text: "Edited a.txt." }],
      details: mutationDetails({
        publication: "PUBLISHED",
        freshness: "unchanged",
        command: "not_requested",
      }),
    },
    { isPartial: false, expanded: false },
    theme,
    context,
  );
  const output = card.render(160).join("\n");
  assert.match(output, /Edited a\.txt/);
  assert.doesNotMatch(output, /publication=|freshness=/);
  tool.renderCall!(args, theme, context);
  tool.renderResult!(
    {
      content: [{ type: "text", text: "Edited a.txt." }],
      details: mutationDetails({
        publication: "PUBLISHED",
        freshness: "changed",
        command: "not_requested",
      }),
    },
    { isPartial: false, expanded: false },
    theme,
    context,
  );
  const staleOutput = card.render(160).join("\n");
  assert.match(staleOutput, /Anchors are stale: target changed/);
  assert.doesNotMatch(staleOutput, /publication=|freshness=/);
});

test("unfused write errors retain the native full diagnostic", () => {
  initTheme("dark");
  const tool = withMutationStatus(makeWriteOverride(process.cwd()));
  const args = { path: "a.txt", content: "new", mode: "overwrite" as const };
  const context: any = { args, state: {}, isPartial: false, isError: true, invalidate() {} };
  const card = tool.renderCall!(args, theme, context);
  tool.renderResult!(
    {
      content: [{ type: "text", text: "write failed\nimportant detail" }],
      details: {
        path: "a.txt",
        created: false,
        publication: "NOT_PUBLISHED",
        publishedRevision: "r",
        observedRevision: "r",
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
    const details = generateMutationDetails(
      "a.txt",
      before,
      after,
      { publishedRevision: "r", observedRevision: "r" },
      "PUBLISHED",
    );
    assert.equal(details.diff, displayCarriageReturns(generateDiffString(before, after).diff));
    assert.match(details.diff, /␍/);
    assert.ok(details.patch.includes("-old\r\n"));
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
    const details = generateMutationDetails(
      "a.txt",
      before,
      before.replace("old", "new"),
      { publishedRevision: "r", observedRevision: "r" },
      "PUBLISHED",
    );
    const tool = makeEditOverride(process.cwd(), DEFAULT_CONFIG);
    const result = tool.renderResult(
      { content: [], details },
      { expanded: true, isPartial: false },
      theme,
      {
        args: { path: "a.txt", edits: [{ op: "append", body: ["new"] }] },
        state: {},
        isError: false,
      } as Parameters<typeof tool.renderResult>[3],
    );
    assert.match(result.render(160).join("\n"), /␍/);
  }
  assert.match(renderDiffPreview("-1 old␍\n+1 new␍", true, theme), /␍/);
});

test("withMutationStatus renderResult initializes mutationShell defensively", () => {
  initTheme("dark");
  const tool = withMutationStatus(makeEditOverride(process.cwd(), DEFAULT_CONFIG));
  const context: any = { args: { path: "a.txt" }, state: {}, isError: false };
  const container = tool.renderResult!(
    {
      content: [{ type: "text", text: "Edited a.txt." }],
      details: mutationDetails({
        publication: "PUBLISHED",
        freshness: "unchanged",
        command: "not_requested",
      }),
    },
    { isPartial: false, expanded: false },
    theme,
    context,
  );
  assert.ok(container);
  assert.ok(context.state.mutationShell);
  assert.ok(context.state.mutationShell.box);
});

test("grep renders anchored and plain groups with shared width and folded indentation", () => {
  initTheme("dark");
  const notice =
    "[Invalid UTF-8: replacement characters shown; plain line numbers cannot be used as edit anchors]";
  const raw = [
    "valid.ts · 2 matches",
    "9#ABCD│  alpha",
    "10#ABCD│    beta",
    "",
    "invalid.txt · 2 matches",
    "100│\tbad �",
    "7│\t\tother",
    notice,
  ].join("\n");
  assert.deepEqual(toDisplayLines(raw, theme), [
    theme.fg("success", "valid.ts") + theme.fg("dim", " · 2 matches"),
    theme.fg("dim", "     9: ") + theme.fg("dim", "›") + " " + theme.fg("toolOutput", "alpha"),
    theme.fg("dim", "    10: ") + theme.fg("dim", "›") + " " + theme.fg("toolOutput", "  beta"),
    theme.fg("toolOutput", ""),
    theme.fg("success", "invalid.txt") + theme.fg("dim", " · 2 matches"),
    theme.fg("dim", "   100: ") + theme.fg("dim", "›") + " " + theme.fg("toolOutput", "bad �"),
    theme.fg("dim", "     7: ") + theme.fg("dim", "›") + " " + theme.fg("toolOutput", "\tother"),
    theme.fg("warning", notice),
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

test("all tools render argument issues as field diagnostics while preserving model JSON", async (t) => {
  initTheme("dark");
  const cwd = process.cwd();
  const { session } = await openTestSession(t, {
    tools: ["forget"],
    configure(pi) {
      registerForgetTool(pi);
    },
  });
  const forget = session.getToolDefinition("forget");
  assert.ok(forget);
  const tools = [
    makeReadOverride(cwd, DEFAULT_CONFIG),
    withMutationStatus(makeEditOverride(cwd, DEFAULT_CONFIG)),
    withMutationStatus(makeReplaceTool(cwd, DEFAULT_CONFIG)),
    withMutationStatus(makeWriteOverride(cwd)),
    makeGrepOverride(cwd, DEFAULT_CONFIG),
    forget,
  ];
  for (const tool of tools) {
    for (const fused of [false, true]) {
      const args = {
        path: "unused.txt",
        content: "unused",
        mode: "create" as const,
        edits: [{ op: "append" as const, body: ["unused"] }],
        replacements: [{ find: "unused", replace: "unused" }],
        pattern: "unused",
        literal: true,
        ids: ["r00000"],
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
        const call = tool.renderCall?.(args, theme, context);
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
          assert.match(displayed, /Prepared arguments/);
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
  const collapsed = renderToolError(result, theme, false).render(120).join("\n");
  const expanded = renderToolError(result, theme, true).render(120).join("\n");
  assert.match(collapsed, /Error header/);
  assert.doesNotMatch(collapsed, /Final cause/);
  assert.match(expanded, /Final cause: permission denied/);
  assert.ok(collapsed.split("\n").length < expanded.split("\n").length);
});

test("argument cards preserve omission notices, all expanded issues and additional error blocks", () => {
  initTheme("dark");
  const issues = Array.from({ length: 200 }, (_, index) => ({
    field: `edits[${index}].body`,
    reason: `中文🙂 ${index}: supply a line.\n${"context ".repeat(50)}\nFinal cause: empty body.`,
  }));
  const diagnostic = formatArgumentError("edit", issues, "x".repeat(20000), true);
  const parsed = argumentError(new Error(diagnostic));
  assert.ok(parsed.argumentsOmitted && parsed.schemaLimited && parsed.omittedIssues);
  const result = {
    content: [
      { type: "text" as const, text: diagnostic },
      { type: "text" as const, text: "Additional cause: hook diagnostic" },
    ],
  };
  const original = structuredClone(result);
  const collapsed = stripVTControlCharacters(
    renderToolError(result, theme, false).render(100).join("\n"),
  );
  const expanded = stripVTControlCharacters(
    renderToolError(result, theme, true).render(100).join("\n"),
  );
  for (const displayed of [collapsed, expanded]) {
    assert.match(displayed, /Prepared arguments omitted/);
    assert.match(displayed, /Schema diagnostic limit/);
    assert.ok(displayed.includes(`${parsed.omittedIssues} issues omitted`));
    assert.doesNotMatch(displayed, /"error":|"issues":/);
  }
  for (const issue of parsed.issues) assert.ok(expanded.includes(issue.field));
  assert.match(expanded, /Final cause: empty body/);
  assert.match(expanded, /Additional cause: hook diagnostic/);
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
      renderToolError(result, theme, true).render(300).join("\n"),
    );
    assert.ok(displayed.includes(diagnostic || "Error"));
  }
});

test("argument diagnostics wrap Unicode and multiline reasons at narrow terminal widths", () => {
  const field = "edits[0].body";
  const reason = '中文🙂: supply at least one line.\nUse ["空行"] for this example.';
  const diagnostic = formatArgumentError("edit", [{ field, reason }], { path: "中文.txt" }, false);
  const result = { content: [{ type: "text" as const, text: diagnostic }] };
  for (const appearance of ["dark", "light"] as const) {
    initTheme(appearance);
    for (const width of [24, 80]) {
      for (const expanded of [false, true]) {
        const lines = renderToolError(result, theme, expanded).render(width);
        assert.ok(lines.every((line) => visibleWidth(line) <= width));
        const displayed = stripVTControlCharacters(lines.join("\n")).replace(/\s/g, "");
        for (const value of [field, reason, "edit not executed"]) {
          assert.ok(displayed.includes(value.replace(/\s/g, "")));
        }
        assert.equal(displayed.includes("中文.txt"), expanded);
      }
    }
  }
  initTheme("dark");
});
