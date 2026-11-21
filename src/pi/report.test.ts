import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { stripVTControlCharacters } from "node:util";
import { Value } from "typebox/value";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { theme } from "../../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js";
import { HashlineError, PATH_ERROR_MESSAGES } from "../core/errors.ts";
import { FileMutationError } from "./file-commit.ts";
import { describeMutationFailure } from "./mutation-result.ts";
import { formatArgumentError } from "./argument-error.ts";
import { renderToolError, splitReport } from "./render.ts";
import { causeOf, describeThrown } from "./report-cause.ts";
import { reportOf, reportResult, describeFailure, renderReport, runTool } from "./report.ts";
import { formatByteSize } from "./budgets.ts";
import { DEFAULT_OUTPUT_BUDGETS } from "./tool-factories.testing.ts";
import { MAX_UNNARROWED_SCAN_BYTES } from "./grep-candidates.ts";
import {
  ERROR_DEFINITIONS,
  OUTCOME_NEXT,
  SCRIPT_OUTPUT_SCHEMAS,
  type Report,
  type ReportTool,
  type SuccessOutcome,
  type SuccessReport,
} from "./report-schema.ts";

// npm run typecheck checks these invalid callers; they must never run.
const signal = new AbortController().signal;

function invalidSuccessProducers() {
  // @ts-expect-error A successful edit requires its publication status.
  reportResult({ tool: "edit" }, [], DEFAULT_OUTPUT_BUDGETS);
  // @ts-expect-error A successful write requires its publication status.
  reportResult({ tool: "write" }, [], DEFAULT_OUTPUT_BUDGETS);
  // @ts-expect-error A successful replacement requires its match count.
  reportResult({ tool: "replace", publication: "PUBLISHED" }, [], DEFAULT_OUTPUT_BUDGETS);
  // @ts-expect-error Grep must produce both counts, even when the payload shows them.
  reportResult({ tool: "grep", matches: 1 }, [], DEFAULT_OUTPUT_BUDGETS);
  // @ts-expect-error A payload showing counts still requires a match count.
  reportResult({ tool: "grep", files: 1, payloadShowsCounts: true }, [], DEFAULT_OUTPUT_BUDGETS);
  reportResult(
    { tool: "read", nextOffset: 2 },
    [],
    DEFAULT_OUTPUT_BUDGETS,
    // @ts-expect-error Visibility cannot provide a second value for a fact.
    { implied: { nextOffset: 3 } },
  );
  // @ts-expect-error A read cannot hide grep counts.
  reportResult({ tool: "read", payloadShowsCounts: true }, [], DEFAULT_OUTPUT_BUDGETS);
}

function invalidReportConstruction(report: Report) {
  // @ts-expect-error Removed facts cannot be supplied to a report.
  const removedFact: Report = { tool: "grep", created: true };
  // @ts-expect-error NO_MATCH requires its unmatched facts.
  const failure: import("./report-schema.ts").FailureReport = {
    tool: "replace",
    error: "NO_MATCH",
    message: "No replacement matched.",
  };
  if (report.error === "NO_MATCH") {
    const unmatched: string[] = report.unmatched;
    // @ts-expect-error NO_MATCH no longer carries a single rule.
    const rule: number = report.rule;
    // @ts-expect-error NO_MATCH cannot carry a search-total fact.
    const matches: number = report.matches;
  }
}

const text = (value: string) => ({ type: "text" as const, text: value });
const reportFromText = (value: string, tool: ReportTool) =>
  reportOf({ content: [text(value)] }, tool);
function displayed(result: Parameters<typeof renderToolError>[0], tool: ReportTool) {
  initTheme("dark");
  return stripVTControlCharacters(
    renderToolError(result, tool, theme, true, { keyHint: (_key, description) => description })
      .render(200)
      .join("\n"),
  );
}

test("structured failure → omits call fields from text and renders the complete details once", async () => {
  const result = await runTool(
    "write",
    { signal, path: "target.txt", budget: DEFAULT_OUTPUT_BUDGETS },
    async () => {
      throw new HashlineError("TARGET_EXISTS", "Target already exists.");
    },
  );
  const before = structuredClone(result);
  const block = result.content[0];
  assert.ok(block.type === "text");
  const serialized: unknown = JSON.parse(block.text);
  assert.ok(typeof serialized === "object" && serialized !== null);
  assert.equal(Object.hasOwn(serialized, "tool"), false);
  assert.equal(Object.hasOwn(serialized, "path"), false);
  assert.equal(result.details.report.tool, "write");
  assert.equal(result.details.report.path, "target.txt");
  assert.equal(reportOf(result, "write"), result.details.report);
  assert.deepEqual(reportFromText(block.text, "write"), {
    tool: "write",
    error: "TARGET_EXISTS",
    message: "Target already exists.",
    next: ERROR_DEFINITIONS.TARGET_EXISTS.next.default,
  });
  const shown = displayed(result, "write");
  assert.match(shown, /TARGET_EXISTS/);
  assert.equal(shown.split("Target already exists.").length - 1, 1);
  assert.doesNotMatch(shown, /"error":/);
  assert.deepEqual(result, before);
});

test("Pi argument failure transported as text → renders field facts after serialization", () => {
  const diagnostic = formatArgumentError(
    [{ field: "pattern", reason: "missing" }],
    false,
    DEFAULT_OUTPUT_BUDGETS,
  );
  const result = JSON.parse(JSON.stringify({ content: [text(diagnostic)] }));
  assert.equal(Object.hasOwn(JSON.parse(diagnostic), "tool"), false);
  assert.equal(Object.hasOwn(JSON.parse(diagnostic), "path"), false);
  const report = reportOf(result, "grep");
  assert.equal(report?.error, "INVALID_ARGUMENTS");
  assert.equal(report?.tool, "grep");
  const shown = displayed(result, "grep");
  assert.match(shown, /pattern: missing/);
  assert.match(shown, /grep not executed/);
  assert.doesNotMatch(shown, /"issues":/);
});

test("invalid serialized report → retains the raw diagnostic", () => {
  const valid = formatArgumentError(
    [{ field: "path", reason: "missing" }],
    false,
    DEFAULT_OUTPUT_BUDGETS,
  );
  for (const invalid of [
    JSON.stringify({ ...JSON.parse(valid), foreign: true }),
    '{"tool":"edit","arbitrary":"user file"}',
    '{"tool":"replace","error":"NO_MATCH","message":"missing rule"}',
    '{"tool":"write","error":"TARGET_EXISTS","rule":1}',
    JSON.stringify({ ...JSON.parse(valid), tool: "foreign" }),
    JSON.stringify({
      ...JSON.parse(valid),
      issues: [{ field: "path", reason: "missing", foreign: true }],
    }),
    JSON.stringify({
      tool: "write",
      error: "FILESYSTEM_ERROR",
      message: "failed",
      cause: { message: "native", foreign: true },
    }),
  ]) {
    assert.equal(reportFromText(invalid, "edit"), undefined, invalid);
    const report: unknown = JSON.parse(invalid);
    for (const details of [undefined, { report }]) {
      const result = { content: [text(invalid)], details };
      assert.equal(reportOf(result, "edit"), undefined);
      assert.equal(
        displayed(result, "edit")
          .split("\n")
          .map((line) => line.trimEnd())
          .join("\n"),
        invalid,
      );
    }
  }
});

test("native failure with deeply nested cause → retains the terminal diagnostic through report decoding", () => {
  const terminal = Object.assign(new Error("permission denied 中文🙂"), { code: "EACCES" });
  let error: Error = terminal;
  for (let index = 0; index < 12; index++)
    error = Object.assign(new Error(`layer ${index}`, { cause: error }), { code: "EIO" });
  const report = describeFailure("grep", error, {
    signal,
    path: "source",
    budget: DEFAULT_OUTPUT_BUDGETS,
  });
  const serialized = renderReport(report);
  const decoded = reportFromText(serialized, "grep");
  assert.ok(decoded);
  assert.deepEqual(decoded, { tool: "grep", ...JSON.parse(serialized) });
  let cause = decoded.cause;
  while (cause?.cause) cause = cause.cause;
  assert.equal(cause?.code, terminal.code);
  assert.equal(cause?.message, terminal.message);
  assert.doesNotMatch(serialized, /"omitted"/);
});

test("aggregate and cyclic causes → preserve only the linear cause chain", () => {
  const terminal = new Error("terminal");
  const aggregate = new AggregateError([terminal, terminal, new Error("ignored")], "aggregate", {
    cause: terminal,
  });
  const self = new Error("self");
  self.cause = self;
  const first = new Error("first");
  const second = new Error("second", { cause: first });
  first.cause = second;
  for (const [input, expected] of [
    [aggregate, { message: "aggregate", cause: { message: "terminal" } }],
    [self, { message: "self" }],
    [first, { message: "first", cause: { message: "second" } }],
  ] as const) {
    assert.deepEqual(causeOf(input, DEFAULT_OUTPUT_BUDGETS.fieldBytes), expected);
  }
});

test("undefined thrown value → has a description while an undefined cause is absent", () => {
  assert.deepEqual(describeThrown(undefined, Infinity), { message: "undefined" });
  assert.equal(causeOf(undefined, Infinity), undefined);
});

test("uninspectable cause or errno → preserves the diagnostic it can read", async (t) => {
  const { proxy, revoke } = Proxy.revocable({}, {});
  revoke();
  const progressError = Object.defineProperty(new Error("Progress display closed"), "code", {
    get() {
      throw new Error("Cannot read errno");
    },
  });
  for (const [name, input, message] of [
    ["revoked proxy", proxy, "The thrown value has no string form."],
    ["throwing errno getter", progressError, "Progress display closed"],
  ] as const) {
    await t.test(name, () => {
      assert.deepEqual(causeOf(input, DEFAULT_OUTPUT_BUDGETS.fieldBytes), { message });
    });
  }
});

test("oversized cause message → retains opening and terminal text within the message budget", () => {
  const cause = causeOf(
    new Error(`opening${"\u0000".repeat(DEFAULT_OUTPUT_BUDGETS.fieldBytes * 2)}terminal`),
    DEFAULT_OUTPUT_BUDGETS.fieldBytes,
  );
  assert.ok(cause);
  assert.match(cause.message, /^opening/);
  assert.match(cause.message, /terminal$/);
  assert.match(cause.message, /omitted/i);
  assert.ok(Buffer.byteLength(cause.message) <= DEFAULT_OUTPUT_BUDGETS.fieldBytes);
});

test("native filesystem failure → reports its diagnostic once without a synthetic cause", () => {
  for (const code of ["EACCES", "ELOOP", "ENOTDIR"]) {
    for (const message of [`${code}: cannot inspect source`, "cannot inspect source"]) {
      const native = Object.assign(new Error(message), { code });
      const report = describeFailure("grep", native, {
        signal,
        path: "source",
        budget: DEFAULT_OUTPUT_BUDGETS,
      });
      assert.equal(report.error, "FILESYSTEM_ERROR");
      assert.equal(report.cause, undefined);
      assert.match(report.message ?? "", new RegExp(code));
      assert.ok(report.message?.includes(message));
      assert.equal(renderReport(report).split(message).length - 1, 1);
    }
  }
});

test("native path errors → classify fixed messages and state the missing path as headers spell paths", () => {
  // Node reports the resolved path the call used, with the platform's separator.
  const resolved = join(tmpdir(), "resolved", "source");
  for (const [code, expected, missing] of [
    ["ENOENT", "PATH_NOT_FOUND", [resolved.replaceAll("\\", "/")]],
    ["EISDIR", "NOT_REGULAR_FILE", undefined],
  ] as const) {
    const native = Object.assign(new Error(`${code}: native diagnostic`), {
      code,
      path: resolved,
    });
    const report = describeFailure("read", native, {
      signal,
      path: "source",
      budget: DEFAULT_OUTPUT_BUDGETS,
    });
    assert.equal(report.error, expected);
    assert.equal(report.message, PATH_ERROR_MESSAGES[expected]);
    assert.deepEqual(report.missing, missing);
    assert.equal(report.cause, undefined);
  }
});

test("mutation publication → recovery reflects whether the change was saved", () => {
  for (const [publication, expected] of [
    ["NOT_PUBLISHED", undefined],
    ["PUBLISHED", "The change is saved; do not repeat it. Read the file before further edits."],
    [
      "UNKNOWN",
      "The change may or may not be saved. Read the file, and repeat the change only if it is missing.",
    ],
  ] as const) {
    const error =
      publication === "NOT_PUBLISHED"
        ? new HashlineError("PUBLISH_FAILED", "failed")
        : new FileMutationError(
            publication === "PUBLISHED" ? "POST_PROCESS_FAILED" : "PUBLISH_FAILED",
            publication,
            "failed",
          );
    const report = describeMutationFailure("edit", error, {
      signal,
      budget: DEFAULT_OUTPUT_BUDGETS,
    });
    assert.equal(report.publication, publication);
    assert.equal(report.next, expected);
    assert.equal(reportFromText(renderReport(report), "edit")?.next, expected);
  }
});

test("success reports → omit repeated call fields while retaining details and payload", () => {
  const report: SuccessOutcome = {
    tool: "write",
    path: "target.txt",
    publication: "PUBLISHED",
  };
  const payload = [text(renderReport(report))];
  const result = reportResult(report, payload, DEFAULT_OUTPUT_BUDGETS);
  const last = result.content.at(-1);
  assert.ok(last?.type === "text");
  assert.deepEqual(JSON.parse(last.text), { publication: "PUBLISHED" });
  assert.deepEqual(result.details.report, report);
  assert.deepEqual(splitReport(result, "write"), { content: payload, report });
  assert.equal(result.content.length, 2);
});

test("success results → scripts receive the stated fields, after the payload text for read and grep", () => {
  const cases: [SuccessOutcome, string | undefined][] = [
    [{ tool: "read", path: "a.txt", nextOffset: 3 }, "one\ntwo"],
    [{ tool: "read", path: "a.txt" }, "one"],
    [{ tool: "grep", path: ["src"], matches: 2, files: 1 }, "src/a.ts"],
    [{ tool: "grep", path: ["src"], matches: 0, files: 0 }, undefined],
    [{ tool: "replace", path: "a.txt", publication: "PUBLISHED", matches: 2 }, undefined],
    [{ tool: "write", path: "a.txt", publication: "PUBLISHED" }, undefined],
  ];
  for (const [report, payload] of cases) {
    const result = reportResult(
      report,
      payload === undefined ? [] : [text(payload)],
      DEFAULT_OUTPUT_BUDGETS,
    );
    const stated = JSON.parse(renderReport(result.details.report));
    assert.deepEqual(
      result.structuredContent,
      report.tool === "read" || report.tool === "grep"
        ? { text: payload ?? "", ...stated }
        : stated,
    );
    assert.ok(Value.Check(SCRIPT_OUTPUT_SCHEMAS[report.tool], result.structuredContent));
  }
});

test("declared script outputs → require the fields every success of the tool carries", () => {
  const incomplete: [ReportTool, object][] = [
    ["read", {}],
    ["grep", { text: "" }],
    ["grep", { text: "", matches: 0 }],
    ["edit", {}],
    ["replace", { publication: "PUBLISHED" }],
    ["replace", { matches: 1 }],
    ["write", {}],
  ];
  for (const [tool, value] of incomplete)
    assert.equal(Value.Check(SCRIPT_OUTPUT_SCHEMAS[tool], value), false, JSON.stringify(value));
});

test("success facts without a tool → use call context and enforce tool-specific fields", () => {
  const report: Report = { tool: "write", publication: "PUBLISHED" };
  const serialized = renderReport(report);
  assert.deepEqual(reportFromText(serialized, "write"), {
    tool: "write",
    publication: "PUBLISHED",
  });
  for (const tool of ["read", "grep"] as const)
    assert.equal(reportFromText(serialized, tool), undefined);
  for (const tool of ["edit", "replace"] as const)
    assert.deepEqual(reportFromText(serialized, tool), { tool, publication: "PUBLISHED" });
  assert.deepEqual(reportFromText(JSON.stringify(report), "write"), report);
  for (const invalid of [
    '{"created":true,"foreign":true}',
    '{"error":"INVALID_ARGUMENTS","message":"missing issues"}',
    '{"tool":"foreign","publication":"PUBLISHED"}',
    '{"tool":"edit","publication":"PUBLISHED"}',
    '{"tool":null,"publication":"PUBLISHED"}',
    "{",
    "[]",
    "null",
  ])
    assert.equal(reportFromText(invalid, "write"), undefined, invalid);
});

test("hook changes a success result → strips no block without matching report position and text", () => {
  const report: SuccessOutcome = { tool: "write", path: "saved.txt", publication: "PUBLISHED" };
  const payload = [text(renderReport(report))];
  const original = reportResult(report, payload, DEFAULT_OUTPUT_BUDGETS);
  const cases = [
    { ...original, content: payload },
    { ...original, details: { report } },
    {
      ...original,
      details: { ...original.details, report: { ...report, publication: "NOT_PUBLISHED" } },
    },
    ...[
      text(JSON.stringify(report, null, 2)),
      text(JSON.stringify({ publication: "NOT_PUBLISHED" })),
      text(renderReport(report) + "\n"),
      { type: "image" as const, data: "iVBORw0KGgo=", mimeType: "image/png" },
    ].map((last) => ({ ...original, content: [...payload, last] })),
  ];
  for (const result of cases) {
    const split = splitReport(result, "write");
    assert.equal(split.report, result.details.report);
    assert.equal(split.content, result.content);
  }
});

test("report-contract: native failure with an independent cause → retains the underlying diagnostic", () => {
  const underlying = Object.assign(new Error("disk read failed"), { code: "EIO" });
  const native = new Error("cannot inspect source", { cause: underlying });
  const report = describeFailure("read", native, {
    signal,
    path: "source",
    budget: DEFAULT_OUTPUT_BUDGETS,
  });
  assert.equal(report.message, native.message);
  assert.equal(report.cause?.message, underlying.message);
  assert.equal(report.cause?.code, "EIO");
});

test("replacement failure facts → survive report serialization", () => {
  for (const report of [
    {
      tool: "replace",
      error: "NO_MATCH",
      message: "No match",
      unmatched: ["replacements[0]", "replacements[2]"],
    },
    {
      tool: "replace",
      error: "OVERLAPPING_MATCHES",
      message: "Overlap",
      conflict: ["replacements[0]", "replacements[1]"],
      line: 2,
    },
  ] satisfies Report[]) {
    assert.deepEqual(reportFromText(renderReport(report), "replace"), report);
  }
});

test("success facts survive details and model serialization", () => {
  for (const report of [
    { tool: "grep", matches: 1 },
    { tool: "grep", matches: 0, scanLimit: formatByteSize(MAX_UNNARROWED_SCAN_BYTES) },
    {
      tool: "grep",
      error: "SEARCH_INCOMPLETE",
      message: "Search incomplete.",
      diagnostics: "unreadable file",
      scanLimit: formatByteSize(MAX_UNNARROWED_SCAN_BYTES),
    },
  ] satisfies Report[]) {
    const serialized = renderReport(report);
    assert.deepEqual(reportFromText(serialized, report.tool), report);
    assert.deepEqual(
      reportOf({ content: [text(serialized)], details: { report } }, report.tool),
      report,
    );
  }
});

test("grep preview from invalid UTF-8 → recovery selects bash for the listed paths", () => {
  const result = reportResult(
    {
      tool: "grep",
      matches: 1,
      files: 1,
      linePreviewLimit: DEFAULT_OUTPUT_BUDGETS.grepPreviewUnits,
      invalidUtf8: ["invalid.txt"],
    },
    [],
    DEFAULT_OUTPUT_BUDGETS,
  );
  const next = reportOf(result, "grep")?.next ?? "";
  assert.match(next, /invalidUtf8.*bash/);
});

test("grep limits coincide → recovery prioritizes output, then match, then scan", () => {
  for (const key of ["matchLimit", "outputLimit"] as const) {
    const next = OUTCOME_NEXT.find(([fact]) => fact === key)?.[1];
    assert.ok(next);
    const result = reportResult(
      {
        tool: "grep",
        matches: 1,
        files: 1,
        matchLimit: 1,
        scanLimit: formatByteSize(MAX_UNNARROWED_SCAN_BYTES),
        ...(key === "outputLimit" && {
          outputLimit: formatByteSize(DEFAULT_OUTPUT_BUDGETS.grepBytes),
        }),
      },
      [],
      DEFAULT_OUTPUT_BUDGETS,
    );
    assert.equal(reportOf(result, "grep")?.next, typeof next === "string" ? next : next.default);
  }
});

test("no-op write target missing after then_run → report omits the no-op recovery", () => {
  const result = reportResult(
    {
      tool: "write",
      publication: "NOT_PUBLISHED",
      freshness: "missing",
      then_run: { status: "succeeded" },
    },
    [],
    DEFAULT_OUTPUT_BUDGETS,
  );
  const report = reportOf({ content: result.content }, "write");
  assert.ok(report);
  assert.equal(report.next, undefined);
});

test("output limit with read next offset → recovery prioritizes the next offset", () => {
  const next = OUTCOME_NEXT.find(([key]) => key === "nextOffset")?.[1];
  assert.ok(next);
  const result = reportResult(
    {
      tool: "read",
      nextOffset: 2,
      outputLimit: formatByteSize(DEFAULT_OUTPUT_BUDGETS.readBytes),
    },
    [],
    DEFAULT_OUTPUT_BUDGETS,
  );
  assert.equal(reportOf(result, "read")?.next, next);
});

test("text-only error contains facts invalid for the originating tool → preserves the raw diagnostic", () => {
  const diagnostic = '{"publication":"PUBLISHED"}';
  const result = { content: [text(diagnostic)] };
  assert.equal(reportOf(result, "read"), undefined);
  assert.equal(displayed(result, "read").trimEnd(), diagnostic);
});

test("invalid details report → falls back to valid text and leaves content intact", () => {
  const tool = "write";
  const fallback: SuccessReport = { tool, publication: "PUBLISHED" };
  const invalidReports: readonly unknown[] = [
    { tool, publication: "invalid" },
    { ...fallback, tool: "edit" },
    { publication: "NOT_PUBLISHED" },
  ];
  const content = [text("payload"), text(renderReport(fallback))];
  for (const report of invalidReports) {
    const result = { details: { report, reportBlockIndex: 1 }, content };
    assert.deepEqual(reportOf(result, tool), fallback);
    const split = splitReport(result, tool);
    assert.equal(split.report, undefined);
    assert.equal(split.content, content);
  }
});

test("live details with an inherited tool → returns the checked report by reference", () => {
  const report = Object.setPrototypeOf({ publication: "NOT_PUBLISHED" }, { tool: "write" });
  assert.equal(reportOf({ details: { report }, content: [] }, "write"), report);
});

test("output byte limit → follows the scan limit and precedes the line preview limit", () => {
  const serialized = renderReport({
    scanLimit: formatByteSize(MAX_UNNARROWED_SCAN_BYTES),
    outputLimit: formatByteSize(DEFAULT_OUTPUT_BUDGETS.grepBytes),
    linePreviewLimit: DEFAULT_OUTPUT_BUDGETS.grepPreviewUnits,
  });
  assert.deepEqual(Object.keys(JSON.parse(serialized)), [
    "scanLimit",
    "outputLimit",
    "linePreviewLimit",
  ]);
});

test("hooked details contain a cyclic report cause → preserves payload and decodes the text report", () => {
  const cause: { message: string; cause?: unknown } = { message: "loop" };
  cause.cause = cause;
  const fallback = {
    tool: "read" as const,
    error: "UNCLASSIFIED" as const,
    message: "raw diagnostic",
  };
  const content = [text(renderReport(fallback))];
  const result = { details: { report: { ...fallback, cause } }, content };
  assert.deepEqual(reportOf(result, "read"), fallback);
  assert.deepEqual(splitReport(result, "read"), { content, report: undefined });
});

test("hook throws while serializing report details → only JSON representation errors allow fallback", () => {
  const fallback = { tool: "read", nextOffset: 2 } satisfies Report;
  const content = [text(renderReport(fallback))];
  const report = {
    ...fallback,
    toJSON() {
      throw new RangeError("hook range");
    },
  };
  assert.deepEqual(reportOf({ details: { report }, content }, "read"), fallback);

  const unexpected = new SyntaxError("hook syntax");
  const foreign = {
    tool: "write",
    toJSON() {
      throw unexpected;
    },
  };
  assert.throws(
    () => reportOf({ details: { report: foreign }, content }, "read"),
    (error) => error === unexpected,
  );

  const unreadable = new TypeError("details getter");
  const details = {
    get report() {
      throw unreadable;
    },
  };
  assert.throws(
    () => reportOf({ details, content }, "read"),
    (error) => error === unreadable,
  );
});

test("native mutation failure before commit → retains publication", () => {
  for (const tool of ["edit", "replace", "write"] as const) {
    const report = describeMutationFailure(tool, new Error("native failure"), {
      signal,
      budget: DEFAULT_OUTPUT_BUDGETS,
    });
    assert.equal(report.publication, "NOT_PUBLISHED", tool);
  }
});

test("failure classification without mutation facts → omits mutation state for every tool", () => {
  for (const tool of ["read", "grep", "edit", "replace", "write"] as const) {
    const error =
      tool === "read" || tool === "grep"
        ? new Error("native failure")
        : new FileMutationError("POST_PROCESS_FAILED", "PUBLISHED", "result generation failed");
    const report = describeFailure(tool, error, { signal, budget: DEFAULT_OUTPUT_BUDGETS });
    assert.equal(
      report.error,
      error instanceof FileMutationError ? "POST_PROCESS_FAILED" : "UNCLASSIFIED",
    );
    assert.equal(report.publication, undefined);
    assert.equal(report.then_run, undefined);
    assert.equal(report.progressError, undefined);
    assert.equal(report.next, undefined);
    const serialized: unknown = JSON.parse(renderReport(report));
    assert.ok(typeof serialized === "object" && serialized !== null);
    for (const field of ["publication", "then_run", "progressError", "next"])
      assert.equal(Object.hasOwn(serialized, field), false);
  }
});

test("mutation freshness → retains the fact and requests reread only for an existing or unknown target", () => {
  for (const freshness of ["missing", "changed", "unknown"] as const) {
    const result = reportResult(
      { tool: "edit", publication: "PUBLISHED", freshness },
      [],
      DEFAULT_OUTPUT_BUDGETS,
    );
    const report = reportOf(result, "edit");
    assert.equal(report?.freshness, freshness);
    if (freshness === "missing") assert.equal(report?.next, undefined);
    else assert.match(report?.next ?? "", /read.*before.*edit|reread/i);
    const block = result.content.at(-1);
    assert.ok(block?.type === "text");
    assert.deepEqual(reportFromText(block.text, "edit"), report);
    assert.equal(Object.hasOwn(JSON.parse(block.text), "next"), freshness !== "missing");
  }
});

test("text-only error resembles a success report → keeps the original diagnostic visible", () => {
  const diagnostic = '{"matches":1}';
  assert.equal(displayed({ content: [text(diagnostic)] }, "grep").trimEnd(), diagnostic);
});

test("read and grep failures cannot carry mutation state → reject invalid replay facts", () => {
  for (const tool of ["read", "grep"] as const) {
    const raw = {
      error: "FILESYSTEM_ERROR",
      message: "disk read failed",
      publication: "PUBLISHED",
    };
    const content = [text(JSON.stringify(raw))];
    assert.equal(reportOf({ content }, tool), undefined);
    assert.equal(
      splitReport({ details: { report: { tool, ...raw } }, content }, tool).report,
      undefined,
    );
  }
});

test("mutation failure carries a freshness fact → rejects the invalid replay report", () => {
  const tool = "edit";
  const failure = {
    error: "PUBLISH_FAILED",
    message: "Publication failed.",
    publication: "NOT_PUBLISHED",
  };
  const valid = {
    content: [text(JSON.stringify(failure))],
    details: { report: { tool, ...failure } },
  };
  assert.deepEqual(reportOf(valid, tool), valid.details.report);
  for (const facts of [
    { freshness: "changed" },
    { freshnessError: { message: "Could not inspect target." } },
  ]) {
    const raw = { ...failure, ...facts };
    const content = [text(JSON.stringify(raw))];
    const details = { report: { tool, ...raw } };
    assert.equal(splitReport({ content, details }, tool).report, undefined);
    assert.equal(reportOf({ content }, tool), undefined);
  }
});
