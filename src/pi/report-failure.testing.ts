import assert from "node:assert/strict";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { ErrorCode, Report } from "./report-schema.ts";
import { detailsReport } from "./report.ts";

/** Assert execution failures through the returned model/TUI report, without changing tool semantics. */
export async function expectToolFailure(
  pending: Promise<AgentToolResult<unknown> & { isError?: boolean }>,
  code: ErrorCode,
  inspect?: (report: Report) => void,
): Promise<Report> {
  const result = await pending;
  assert.equal(result.isError, true);
  const details = result.details;
  assert.ok(typeof details === "object" && details !== null && "report" in details);
  const value = details.report;
  assert.ok(typeof value === "object" && value !== null && "tool" in value);
  const tool = (["read", "grep", "edit", "replace", "write"] as const).find(
    (name) => name === value.tool,
  );
  assert.ok(tool);
  const report = detailsReport(details, tool);
  assert.ok(report);
  assert.equal(report.error, code);
  inspect?.(report);
  return report;
}
