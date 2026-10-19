import assert from "node:assert/strict";
import { test } from "node:test";
import { stripVTControlCharacters } from "node:util";
import { formatSize, initTheme } from "@earendil-works/pi-coding-agent";
import { theme } from "../../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js";
import { formatArgumentError } from "./argument-error.ts";
import { renderToolError, splitReport } from "./render.ts";
import {
  causeOf,
  decodeReport,
  failureResult,
  reportOf,
  reportResult,
  describeFailure,
  renderReport,
} from "./report.ts";
import { DEFAULT_OUTPUT_BUDGETS } from "./budgets.ts";
import { MAX_UNNARROWED_SCAN_BYTES } from "./grep-candidates.ts";
import { OUTCOME_NEXT, type Report, type SuccessReport } from "./report-schema.ts";

// npm run typecheck checks these invalid callers; they must never run.
function invalidReportConstruction(report: NonNullable<ReturnType<typeof decodeReport>>) {
  // @ts-expect-error Grep successes cannot contain write-only facts.
  reportResult({ tool: "grep", created: true });
  // @ts-expect-error NO_MATCH requires its rule fact.
  failureResult({ tool: "replace", error: "NO_MATCH", message: "No replacement matched." });
  if (report.error === "NO_MATCH") {
    const rule: number = report.rule;
    // @ts-expect-error NO_MATCH cannot carry a search-total fact.
    const matches: number = report.matches;
  }
}

const text = (value: string) => ({ type: "text" as const, text: value });
function displayed(result: Parameters<typeof renderToolError>[0]) {
  initTheme("dark");
  return stripVTControlCharacters(renderToolError(result, theme, true).render(200).join("\n"));
}

test("structured failure → renders its report once from details", () => {
  const result = failureResult({
    tool: "write",
    error: "TARGET_EXISTS",
    message: "Target already exists.",
  });
  const before = structuredClone(result);
  assert.equal(reportOf(result), result.details.report);
  const shown = displayed(result);
  assert.match(shown, /TARGET_EXISTS/);
  assert.equal(shown.split("Target already exists.").length - 1, 1);
  assert.doesNotMatch(shown, /"error":/);
  assert.deepEqual(result, before);
});

test("Pi argument failure transported as text → renders field facts after serialization", () => {
  const diagnostic = formatArgumentError(
    "edit",
    [{ field: "edits[0].body", reason: "is empty" }],
    false,
  );
  const result = JSON.parse(JSON.stringify({ content: [text(diagnostic)] }));
  assert.equal(reportOf(result)?.error, "INVALID_ARGUMENTS");
  const shown = displayed(result);
  assert.match(shown, /edits\[0\]\.body: is empty/);
  assert.doesNotMatch(shown, /"issues":/);
});

test("argument reports with obsolete fields → remain raw on replay", () => {
  for (const facts of [{ arguments: { path: "saved.txt" } }, { argumentsOmitted: true }]) {
    const report = {
      tool: "edit",
      error: "INVALID_ARGUMENTS",
      issues: [{ field: "edits[0].body", reason: "is empty" }],
      ...facts,
    };
    const diagnostic = JSON.stringify(report);
    const result = { content: [text(diagnostic)], details: { report } };
    assert.equal(decodeReport(diagnostic), undefined);
    assert.equal(reportOf(result), undefined);
    assert.equal(displayed(result).trimEnd(), diagnostic);
  }
});

test("invalid serialized report → retains the raw diagnostic", () => {
  const valid = formatArgumentError("edit", [{ field: "path", reason: "missing" }], false);
  for (const invalid of [
    '{"tool":"edit","arbitrary":"user file"}',
    '{"tool":"replace","error":"NO_MATCH","message":"missing rule"}',
    '{"tool":"write","error":"TARGET_EXISTS","rule":1}',
    valid.replace('"tool": "edit"', '"tool": "foreign"'),
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
    assert.equal(decodeReport(invalid), undefined, invalid);
    assert.equal(
      displayed({ content: [text(invalid)] })
        .split("\n")
        .map((line) => line.trimEnd())
        .join("\n"),
      invalid,
    );
  }
});

test("native failure with deeply nested cause → retains the terminal diagnostic through report decoding", () => {
  const terminal = Object.assign(new Error("permission denied 中文🙂"), { code: "EACCES" });
  let error: Error = terminal;
  for (let index = 0; index < 12; index++)
    error = Object.assign(new Error(`layer ${index}`, { cause: error }), { code: "EIO" });
  const report = describeFailure("grep", error, { path: "source" });
  const serialized = renderReport(report);
  const decoded = decodeReport(serialized);
  assert.ok(decoded);
  assert.deepEqual(decoded, JSON.parse(serialized));
  let cause = decoded.cause;
  while (cause?.cause) cause = cause.cause;
  assert.equal(cause?.code, terminal.code);
  assert.equal(cause?.message, terminal.message);
  assert.doesNotMatch(serialized, /"omitted"/);
});

test("wide and repeated cause graph with a cycle → retains every distinct failure", () => {
  const repeated = new Error("repeated failure");
  const errors = Array.from({ length: 24 }, (_, index) => new Error(`failure ${index}`));
  const aggregate = new AggregateError([repeated, repeated, ...errors], "root");
  aggregate.cause = aggregate;
  const cause = causeOf(aggregate);
  assert.ok(cause);
  assert.equal(cause.cause, undefined);
  assert.deepEqual(
    cause.errors?.map((value) => value.message),
    [repeated.message, ...errors.map((error) => error.message)],
  );
  assert.doesNotMatch(JSON.stringify(cause), /"omitted"/);
});

test("oversized cause message → retains opening and terminal text within the message budget", () => {
  const cause = causeOf(
    new Error(`opening${"\u0000".repeat(DEFAULT_OUTPUT_BUDGETS.fieldBytes * 2)}terminal`),
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
      const report = describeFailure("grep", native, { path: "source" });
      assert.equal(report.error, "FILESYSTEM_ERROR");
      assert.equal(report.cause, undefined);
      assert.match(report.message ?? "", new RegExp(code));
      assert.ok(report.message?.includes(message));
      assert.equal(renderReport(report).split(message).length - 1, 1);
    }
  }
});

test("success reports → omit repeated call fields while retaining details and payload", () => {
  const report: SuccessReport = {
    tool: "write",
    path: "target.txt",
    publication: "PUBLISHED",
    created: true,
  };
  const payload = [text("payload")];
  const result = reportResult(report, payload);
  const last = result.content.at(-1);
  assert.ok(last?.type === "text");
  assert.deepEqual(JSON.parse(last.text), { publication: "PUBLISHED", created: true });
  assert.deepEqual(result.details.report, report);
  assert.deepEqual(splitReport(result), { content: payload, report });
  assert.equal(result.content.length, 2);
});

test("success facts without a tool → require call context and still enforce tool-specific fields", () => {
  const report: Report = { tool: "write", publication: "PUBLISHED", created: true };
  const serialized = renderReport(report);
  assert.equal(decodeReport(serialized), undefined);
  assert.deepEqual(decodeReport(serialized, "write"), report);
  for (const tool of ["read", "foreign"]) assert.equal(decodeReport(serialized, tool), undefined);
  for (const invalid of [
    '{"created":true,"foreign":true}',
    '{"error":"TARGET_EXISTS","message":"exists"}',
    '{"tool":"foreign","created":true}',
    "[]",
    "null",
  ])
    assert.equal(decodeReport(invalid, "write"), undefined);
});

test("checked report with a different trailing block → preserves the entire payload", () => {
  const report: SuccessReport = { tool: "write", path: "saved.txt", publication: "PUBLISHED" };
  for (const last of [
    text(JSON.stringify(report, null, 2)),
    text(JSON.stringify({ publication: "NOT_PUBLISHED" })),
    text(renderReport(report) + "\n"),
    { type: "image" as const, data: "iVBORw0KGgo=", mimeType: "image/png" },
  ]) {
    const content = [text("saved payload"), last];
    const result: Parameters<typeof splitReport>[0] = { content, details: { report } };
    assert.deepEqual(splitReport(result), { content, report });
    assert.equal(splitReport(result).content, content);
  }
});

test("report-contract: native failure with an independent cause → retains the underlying diagnostic", () => {
  const underlying = Object.assign(new Error("disk read failed"), { code: "EIO" });
  const native = new Error("cannot inspect source", { cause: underlying });
  const report = describeFailure("read", native, { path: "source" });
  assert.equal(report.message, native.message);
  assert.equal(report.cause?.message, underlying.message);
  assert.equal(report.cause?.code, "EIO");
});

test("grep success and incomplete candidate facts → survive report serialization", () => {
  for (const report of [
    { tool: "grep", matches: 1 },
    { tool: "grep", matches: 1, candidates: "files" },
    {
      tool: "grep",
      matches: 0,
      candidates: "all",
      scanLimit: formatSize(MAX_UNNARROWED_SCAN_BYTES),
    },
    {
      tool: "grep",
      error: "SEARCH_INCOMPLETE",
      message: "Search incomplete.",
      diagnostics: "unreadable file",
      candidates: "all",
      scanLimit: formatSize(MAX_UNNARROWED_SCAN_BYTES),
    },
  ] satisfies Report[]) {
    const serialized = renderReport(report);
    assert.deepEqual(decodeReport(serialized, report.tool), report);
    assert.deepEqual(reportOf({ content: [text(serialized)], toolName: report.tool }), report);
  }
});

test("match and scan limits → recovery prioritizes the match limit", () => {
  const next = OUTCOME_NEXT.find(([fact]) => fact === "matchLimit")?.[1];
  assert.ok(next);
  const result = reportResult({
    tool: "grep",
    matches: 1,
    matchLimit: 1,
    candidates: "all",
    scanLimit: formatSize(MAX_UNNARROWED_SCAN_BYTES),
  });
  assert.equal(reportOf(result)?.next, next);
});

test("text-only error resembles success facts → preserves the raw error diagnostic", () => {
  const result = { toolName: "read", isError: true, content: [text("{}")] };
  assert.equal(reportOf(result), undefined);
  assert.equal(displayed(result).trimEnd(), "{}");
});

test("invalid details report → falls back to valid text and leaves content intact", () => {
  const details = { report: { tool: "grep", matches: "x" } };
  const fallback: SuccessReport = { tool: "grep", matches: 1, files: 1 };
  for (const expected of [undefined, fallback]) {
    const last = expected ? renderReport(expected) : JSON.stringify({ matches: "x" }, null, 2);
    const result = { toolName: "grep", details, content: [text("payload"), text(last)] };
    assert.deepEqual(reportOf(result), expected);
    assert.deepEqual(splitReport(result), { content: result.content, report: undefined });
    assert.equal(result.content.length, 2);
  }
});
