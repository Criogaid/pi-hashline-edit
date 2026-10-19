import assert from "node:assert/strict";
import { parseFileHeader } from "./grep-output.ts";
import { reportOf } from "./report.ts";

/** Read successful grep totals from their report or the single complete payload block. */
export function grepCounts(result: Parameters<typeof reportOf>[0]): {
  matches: number;
  files: number;
} {
  const report = reportOf(result, "grep");
  assert.ok(report?.tool === "grep" && report.error === undefined, JSON.stringify(report));
  if (report.matches !== undefined) {
    assert.ok(typeof report.files === "number");
    return { matches: report.matches, files: report.files };
  }
  assert.equal(report.files, undefined);
  const payload = result.content?.[0];
  assert.ok(payload?.type === "text");
  const header = parseFileHeader(payload.text.split("\n")[0]);
  if (header) return { matches: Number.parseInt(header.summary, 10), files: 1 };
  const count = /^.+: (\d+)$/.exec(payload.text);
  assert.ok(count, `Missing grep counts: ${payload.text}`);
  return { matches: Number(count[1]), files: 1 };
}
