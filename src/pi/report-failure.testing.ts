import assert from "node:assert/strict";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { ErrorCode } from "../core/errors.ts";
import type { Report } from "./report-schema.ts";
import { reportOf } from "./report.ts";

/** Assert execution failures through the returned model/TUI report, without changing tool semantics. */
export async function expectToolFailure(
  pending: Promise<AgentToolResult<unknown> & { isError?: boolean }>,
  code: ErrorCode,
  inspect?: (report: Report) => void,
): Promise<Report> {
  const result = await pending;
  assert.equal(result.isError, true);
  const report = reportOf(result);
  assert.ok(report);
  assert.equal(report.error, code);
  inspect?.(report);
  return report;
}
