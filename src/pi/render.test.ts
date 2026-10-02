import { test } from "node:test";
import assert from "node:assert/strict";
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

test("edit call titles show structured batches and tolerate invalid partial input", () => {
  initTheme("dark");
  const tool = makeEditOverride(process.cwd(), DEFAULT_CONFIG);
  const edits = [
    { op: "replace" as const, anchor: "1#AB", body: ["new"] },
    { op: "append" as const, body: ["more"] },
  ];
  const render = (value: unknown) =>
    tool
      .renderCall({ path: "f.txt", edits: value } as Parameters<typeof tool.renderCall>[0], theme, {
        state: {},
      } as Parameters<typeof tool.renderCall>[2])
      .render(120)
      .join("\n");
  assert.match(render(edits), /2 ops: replace/);
  assert.doesNotMatch(render(JSON.stringify(edits)), /ops:/);
  assert.doesNotMatch(render("[{bad"), /ops:/);
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
  const args = { path: "a.txt", content: "new" };
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

test("all file tools expose validation causes in collapsed and expanded error cards", async () => {
  initTheme("dark");
  const cwd = process.cwd();
  const tools = [
    makeReadOverride(cwd, DEFAULT_CONFIG),
    withMutationStatus(makeEditOverride(cwd, DEFAULT_CONFIG)),
    withMutationStatus(makeReplaceTool(cwd, DEFAULT_CONFIG)),
    withMutationStatus(makeWriteOverride(cwd)),
  ];
  for (const tool of tools) {
    for (const fused of [false, true]) {
      const args = {
        path: "unused.txt",
        content: "unused",
        edits: [{ op: "append" as const, body: ["unused"] }],
        replacements: [{ find: "unused", replace: "unused" }],
        unexpected: true,
        ...(fused ? { then_run: { command: "must-not-run" } } : {}),
      };
      let errorText = "";
      await assert.rejects(callTool(tool, args), (error: unknown) => {
        assert.ok(error instanceof Error);
        errorText = error.message;
        return true;
      });
      const cause = errorText.split("\n").find((line) => line.includes("unexpected"));
      assert.ok(cause);
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
        assert.ok(
          card.render(200).join("\n").includes(cause),
          `${tool.name} hid the validation cause`,
        );
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
