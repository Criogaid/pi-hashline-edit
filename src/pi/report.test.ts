import assert from "node:assert/strict";
import { test } from "node:test";
import { stripVTControlCharacters } from "node:util";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { theme } from "../../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js";
import { HashlineError } from "../core/errors.ts";
import { formatArgumentError } from "./argument-error.ts";
import { renderToolError } from "./render.ts";
import {
  causeOf,
  decodeReport,
  failureResult,
  reportOf,
  describeFailure,
  renderReport,
} from "./report.ts";
import { MAX_ERROR_TEXT_BYTES } from "./budgets.ts";
import { REPORT_VERSION } from "./report-schema.ts";

const text = (value: string) => ({ type: "text" as const, text: value });
const image = { type: "image" as const, data: "AA==", mimeType: "image/png" };
function displayed(result: Parameters<typeof renderToolError>[0]) {
  initTheme("dark");
  return stripVTControlCharacters(renderToolError(result, theme, true).render(200).join("\n"));
}

test("report-contract: hook content surrounding an error → retains order and renders only the owned block", () => {
  const original = failureResult({
    tool: "write",
    error: "TARGET_EXISTS",
    message: "Target already exists.",
  });
  for (const content of [
    [text("permission context"), ...original.content, text("hook recovery")],
    [...original.content, text("hook recovery"), image],
    [text("permission denied by hook")],
  ]) {
    const result = { ...original, content };
    const before = structuredClone(result);
    const shown = displayed(result);
    const hookText = content.flatMap((block) =>
      block.type === "text" && !block.text.startsWith("{") ? [block.text] : [],
    );
    for (const value of hookText) assert.ok(shown.includes(value), shown);
    if (content.some((block) => block === original.content[0])) {
      assert.match(shown, /TARGET_EXISTS/);
      assert.doesNotMatch(shown, /"error":/);
      if (hookText.length === 2)
        assert.ok(
          shown.indexOf(hookText[0]) < shown.indexOf("TARGET_EXISTS") &&
            shown.indexOf("TARGET_EXISTS") < shown.indexOf(hookText[1]),
        );
    } else assert.doesNotMatch(shown, /Target already exists/);
    assert.equal(result.isError, true);
    assert.deepEqual(result, before);
  }
});

test("report-contract: argument text-only replay with hook and image tails → recovers the report and all hook text", () => {
  const diagnostic = formatArgumentError(
    "edit",
    [{ field: "edits[0].body", reason: "is empty" }],
    { edits: [] },
    false,
  );
  for (const tail of [text("hook recovery"), image]) {
    const result = JSON.parse(
      JSON.stringify({
        content: [text("hook context"), text(diagnostic), tail],
        details: undefined,
      }),
    );
    assert.equal(reportOf(result)?.error, "INVALID_ARGUMENTS");
    const shown = displayed(result);
    assert.match(shown, /edits\[0\]\.body: is empty/);
    assert.match(shown, /hook context/);
    if (tail.type === "text") assert.match(shown, /hook recovery/);
    assert.doesNotMatch(shown, /"issues":/);
  }
});

test("report-contract: foreign or invalid reports → retain the complete raw diagnostic", () => {
  const valid = formatArgumentError("edit", [{ field: "path", reason: "missing" }], {}, false);
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
      $hashline: REPORT_VERSION,
      tool: "write",
      error: "FILESYSTEM_ERROR",
      message: "failed",
      cause: { message: "native", foreign: true },
    }),
    JSON.stringify({ ...JSON.parse(valid), $hashline: 999 }),
  ])
    assert.equal(decodeReport(invalid), undefined, invalid);
  const ambiguous = { content: [text(valid), text(valid), text("hook tail")], details: undefined };
  assert.equal(reportOf(ambiguous), undefined);
  const shown = displayed(ambiguous);
  assert.match(shown, /"issues":/);
  assert.match(shown, /hook tail/);
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
  const cause = causeOf(new Error(`opening${"\u0000".repeat(MAX_ERROR_TEXT_BYTES * 2)}terminal`));
  assert.ok(cause);
  assert.match(cause.message, /^opening/);
  assert.match(cause.message, /terminal$/);
  assert.match(cause.message, /omitted/i);
  assert.ok(Buffer.byteLength(cause.message) <= MAX_ERROR_TEXT_BYTES);
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

test("report-contract: current reports → serialize facts without a protocol marker", () => {
  const report = { tool: "write", publication: "PUBLISHED", created: true } satisfies Parameters<
    typeof renderReport
  >[0];
  assert.deepEqual(JSON.parse(renderReport(report)), report);
});

test("report-contract: saved marked reports → retain live and text-only rendering with surrounding hook text", () => {
  const original = failureResult({
    tool: "write",
    error: "TARGET_EXISTS",
    message: "Target exists.",
  });
  const marked = JSON.stringify({ $hashline: REPORT_VERSION, ...original.details.report }, null, 2);
  for (const details of [original.details, undefined]) {
    const result = {
      ...original,
      details,
      content: [text("hook prefix"), text(marked), text("hook suffix")],
    };
    assert.equal(reportOf(result)?.error, "TARGET_EXISTS");
    const shown = displayed(result);
    assert.match(shown, /hook prefix/);
    assert.match(shown, /Target exists/);
    assert.match(shown, /hook suffix/);
    assert.doesNotMatch(shown, /\"\$hashline\"/);
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

test("report-contract: unmarked success JSON → decodes as data without claiming an unrelated content block", () => {
  const report = { tool: "grep", matches: 1 };
  const serialized = renderReport(report);
  assert.deepEqual(decodeReport(serialized), report);
  assert.equal(reportOf({ content: [text(serialized)] }), undefined);
});
