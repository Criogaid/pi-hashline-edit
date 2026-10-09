/**
 * Shared helpers for the hashline-aware tool renderers.
 *
 * Mutation previews and shared error presentation for the user-facing TUI.
 *
 * @module pi-hashline-edit/pi
 */

import {
  renderDiff,
  type Theme,
  type ToolRenderResultOptions,
} from "@earendil-works/pi-coding-agent";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { Text, type Component } from "@earendil-works/pi-tui";
import type { ToolReport, CommandFact } from "../core/report-schema.ts";
import { reportNext, mutationCompleted } from "./report.ts";
import { reportOf } from "./tool-error.ts";

/** Max diff lines shown when a result is rendered collapsed. */
const MAX_COLLAPSED_DIFF_LINES = 24;
/** Collapsed tool output and errors share a bounded preview. */
const MAX_COLLAPSED_OUTPUT_LINES = 15;

/**
 * Render a pi-format diff (`+N`/`-N`/` N` content) for the TUI, reusing pi's
 * built-in renderer: semantic diff colors plus intra-line (word-level) change
 * highlighting on single-line modifications. When not expanded, collapse to the
 * first 24 rendered lines with an overflow marker — truncating after rendering
 * keeps `-`/`+` pairs intact so the intra-line highlight never dangles.
 */
export function renderDiffPreview(diff: string, expanded: boolean, theme: Theme): string {
  const rendered = renderDiff(diff);
  if (expanded) return rendered;
  const allLines = rendered.split("\n");
  const more =
    allLines.length > MAX_COLLAPSED_DIFF_LINES
      ? `\n${theme.fg("dim", `… (${allLines.length - MAX_COLLAPSED_DIFF_LINES} more)`)}`
      : "";
  return allLines.slice(0, MAX_COLLAPSED_DIFF_LINES).join("\n") + more;
}

/** Added/removed line counts of a pi-format diff string (`+N`/`-N` leading char). */
export interface DiffCounts {
  added: number;
  removed: number;
}

/** Row-local render state shared by the mutation call and result renderers. */
export interface MutationRenderState {
  diffCounts?: DiffCounts;
  callText?: Text;
}

/** Count added/removed lines in a pi-format diff (`+N content` / `-N content` / ` N content`). */
export function countDiffLines(diff: string): DiffCounts {
  let added = 0;
  let removed = 0;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+")) added++;
    else if (line.startsWith("-")) removed++;
  }
  return { added, removed };
}

/** Format `+N -N` with the theme's diff colors for the tool call header. */
export function formatDiffCounts(counts: DiffCounts, theme: Theme): string {
  return ` ${theme.fg("toolDiffAdded", `+${counts.added}`)} ${theme.fg("toolDiffRemoved", `-${counts.removed}`)}`;
}

/**
 * Stash per-call diff counts into the row-local render state and refresh the
 * call header component in place — pi's own edit-tool pattern (renderResult
 * mutates the component stashed by renderCall; it never re-runs the renderer).
 *
 * `updateDisplay` runs renderCall before renderResult in every pass, so later
 * passes (expand/collapse, result updates) rebuild the header from
 * `state.diffCounts`; the in-place refresh covers the first result render,
 * where renderCall ran before the counts existed. renderResult cannot find the
 * header via `lastComponent` — there it is the *result* component — so
 * renderCall stashes it (e.g. `state.callText`).
 *
 * MUST NOT call `context.invalidate()`: it re-enters `updateDisplay`
 * synchronously (not re-entrant) and the outer pass then re-adds the result
 * component after the nested one — the diff renders twice.
 */
export function publishDiffCounts(
  diff: string | undefined,
  context: { state?: MutationRenderState },
  refreshHeader: (counts: DiffCounts) => void,
): void {
  if (!diff || !context?.state) return;
  const counts = countDiffLines(diff);
  const prev: DiffCounts | undefined = context.state.diffCounts;
  context.state.diffCounts = counts;
  if (!prev || prev.added !== counts.added || prev.removed !== counts.removed)
    refreshHeader(counts);
}

/** Reuse the call component and retain it for the result's in-place count refresh. */
export function renderMutationCall<TArgs>(
  args: TArgs,
  theme: Theme,
  context: { lastComponent?: Component; state?: MutationRenderState },
  header: (args: TArgs, theme: Theme, counts?: DiffCounts) => string,
): Text {
  const text = (context?.lastComponent as Text | undefined) ?? new Text("", 0, 0);
  if (context?.state) context.state.callText = text;
  text.setText(header(args, theme, context?.state?.diffCounts));
  return text;
}

/** Render a bounded preview; expanding reveals every supplied line. */
export function renderOutputPreview(
  lines: readonly string[],
  expanded: boolean,
  theme: Theme,
): Text {
  const shown = expanded ? lines : lines.slice(0, MAX_COLLAPSED_OUTPUT_LINES);
  const more =
    shown.length < lines.length
      ? `\n${theme.fg("muted", `… (${lines.length - shown.length} more lines)`)}`
      : "";
  return new Text(shown.join("\n") + more, 0, 0);
}

/** One fact as `key: value`; lists and objects continue on indented lines. */
function factLines(key: string, value: unknown, theme: Theme, indent = ""): string[] {
  const label = `${indent}${theme.fg("accent", key)}:`;
  if (value === null || typeof value !== "object") {
    const [first, ...rest] = String(value).split("\n");
    return [`${label} ${first}`, ...rest.map((line) => `${indent}  ${line}`)];
  }
  if (!Array.isArray(value))
    return [
      label,
      ...Object.entries(value).flatMap(([k, v]) => factLines(k, v, theme, `${indent}  `)),
    ];
  return [
    label,
    ...value.flatMap((item: unknown) => {
      if (item === null || typeof item !== "object") return [`${indent}  - ${String(item)}`];
      // Scalar fields share the item's line; nested lists follow it.
      const entries = Object.entries(item);
      const scalars = entries.filter(([, v]) => v === null || typeof v !== "object");
      const nested = entries.filter(([, v]) => v !== null && typeof v === "object");
      return [
        `${indent}  - ${scalars.map(([k, v]) => `${k}: ${String(v)}`).join(" · ")}`,
        ...nested.flatMap(([k, v]) => factLines(k, v, theme, `${indent}    `)),
      ];
    }),
  ];
}

/** Render metadata directly from the report; payload adapters only style content rows. */
export function reportLines(report: ToolReport, theme: Theme): string[] {
  const color = report.outcome === "failure" ? "error" : "success";
  const lines = [theme.fg(color, theme.bold(report.error?.code ?? report.outcome))];
  if (report.error) {
    lines.push(theme.fg("error", report.error.message));
    for (const [key, value] of Object.entries(report.error.facts))
      lines.push(...factLines(key, value, theme));
  }
  for (const key of [
    "causes",
    "mutation",
    "command",
    "read",
    "search",
    "edit",
    "replace",
    "forget",
    "progressFailures",
  ] as const) {
    const value = report[key];
    if (value !== undefined) lines.push(...factLines(key, value, theme));
  }
  if (report.anchors?.omitted)
    lines.push(...factLines("omittedAnchors", report.anchors.omitted, theme));
  const next = reportNext(report);
  if (next) lines.push(`${theme.fg("dim", "next:")} ${next}`);
  return lines;
}

/** A command card projects command facts; its native Bash adapter owns output styling. */
export function commandDetailLines(command: CommandFact, theme: Theme): string[] {
  return [
    ...(command.blockedBy ? factLines("blockedBy", command.blockedBy, theme) : []),
    ...(command.causes?.length ? factLines("causes", command.causes, theme) : []),
    ...(command.terminate ? factLines("terminate", command.terminate, theme) : []),
  ];
}

export function renderToolError(
  result: Pick<AgentToolResult<unknown>, "content" | "details">,
  theme: Theme,
  expanded: boolean,
): Text {
  const report = reportOf(result);
  const lines = report
    ? reportLines(report, theme)
    : result.content.flatMap((block) =>
        block.type === "text" ? block.text.split("\n").map((line) => theme.fg("error", line)) : [],
      );
  return renderOutputPreview(lines, expanded, theme);
}

export function renderReportResult(
  result: AgentToolResult<unknown>,
  expanded: boolean,
  theme: Theme,
  payload: (text: string) => string[] = (text) => text.split("\n"),
): Text {
  const report = reportOf(result);
  if (!report) return renderToolError(result, theme, expanded);
  return renderOutputPreview(
    [...reportLines(report, theme), ...report.payload.flatMap(payload)],
    expanded,
    theme,
  );
}

/** Render a mutation report and its diff, refreshing the call header in place. */
export function renderMutationResult<TArgs>(
  result: AgentToolResult<unknown>,
  { isPartial, expanded }: ToolRenderResultOptions,
  theme: Theme,
  context: { isError: boolean; args: TArgs; state?: MutationRenderState },
  pending: string,
  fallback: string,
  header: (args: TArgs, theme: Theme, counts?: DiffCounts) => string,
): Text {
  const details = result.details;
  if (isPartial && !mutationCompleted(reportOf(result)))
    return new Text(theme.fg("warning", pending), 0, 0);
  if (context.isError) return renderToolError(result, theme, expanded);
  const diff =
    details && typeof details === "object"
      ? "displayDiff" in details && typeof details.displayDiff === "string"
        ? details.displayDiff
        : "diff" in details && typeof details.diff === "string"
          ? details.diff
          : undefined
      : undefined;
  publishDiffCounts(diff, context, (counts) =>
    context.state?.callText?.setText(header(context.args, theme, counts)),
  );
  const report = reportOf(result);
  const lines = report ? reportLines(report, theme) : [theme.fg("success", fallback)];
  if (diff) lines.push(renderDiffPreview(diff, expanded, theme));
  return renderOutputPreview(lines, expanded, theme);
}
