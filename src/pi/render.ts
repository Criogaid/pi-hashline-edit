/**
 * Shared helpers for the hashline-aware tool renderers.
 *
 * Mutation previews and the one TUI presentation of a report (report.ts): every
 * card renders its result's facts from the structured report in `details`,
 * never from the model text. Argument rejections are the exception Pi forces:
 * they are raised before execution and arrive as text only, so they are decoded
 * with the report codec.
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
import type { ActionFusionProgress } from "./action-fusion.ts";
import {
  renderReport,
  reportEntries,
  reportOf,
  type Report,
  type ReportDetails,
} from "./report.ts";

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

/** A value on one line when it is a scalar; lists and objects continue on indented lines. */
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

/** An argument rejection: highlighted field rows, omission notices first, the argument copy when expanded. */
function argumentLines(report: Report, theme: Theme, expanded: boolean): string[] {
  const lines = [theme.fg("error", theme.bold(`Invalid arguments · ${report.tool} not executed`))];
  // Keep source omission notices ahead of the bounded collapsed preview.
  if (report.argumentsOmitted)
    lines.push(theme.fg("warning", "Prepared arguments omitted from diagnostic."));
  if (report.schemaLimited)
    lines.push(
      theme.fg("warning", "Schema diagnostic limit reached; additional issues may remain."),
    );
  if (report.omittedIssues)
    lines.push(theme.fg("warning", `${report.omittedIssues} issues omitted from diagnostic.`));
  for (const { field, reason, fix } of report.issues ?? []) {
    const [first, ...rest] = reason.split("\n");
    lines.push(`${theme.fg("accent", theme.bold(field))}: ${theme.fg("error", first)}`);
    lines.push(...rest.map((line) => `  ${theme.fg("error", line)}`));
    if (fix) lines.push(`  ${theme.fg("dim", fix)}`);
  }
  if (expanded && Object.hasOwn(report, "arguments")) {
    lines.push("", theme.fg("dim", "Prepared arguments:"));
    lines.push(
      ...JSON.stringify(report.arguments, null, 2)
        .split("\n")
        .map((line) => theme.fg("dim", line)),
    );
  }
  return lines;
}

/** Fields every card shows in its own header or call line. */
const ENVELOPE_FIELDS = ["error", "tool", "path", "publication", "stage", "message", "next"];

/**
 * The one TUI presentation of a report: for a failure, a header with the code,
 * tool, and path, the publication line, and the message; then one `key: value`
 * row per fact in report order, and `next` last. `shown` names facts the card
 * already presents another way (a diff, a separate command card).
 */
export function reportLines(
  report: Report,
  theme: Theme,
  expanded: boolean,
  shown: ReadonlySet<string> = new Set(),
): string[] {
  if (report.error === "INVALID_ARGUMENTS") return argumentLines(report, theme, expanded);
  const lines: string[] = [];
  if (report.error !== undefined) {
    const { path } = report;
    const target = path === undefined ? "" : ` ${Array.isArray(path) ? path.join(", ") : path}`;
    lines.push(theme.fg("error", theme.bold(`${report.error} · ${report.tool}${target}`)));
    if (report.publication !== undefined)
      lines.push(
        theme.fg(
          report.publication === "NOT_PUBLISHED" ? "dim" : "warning",
          `${report.publication}${report.stage === undefined ? "" : ` · ${report.stage}`}`,
        ),
      );
    if (report.message !== undefined)
      lines.push(...report.message.split("\n").map((line) => theme.fg("error", line)));
  }
  for (const [key, value] of reportEntries(report)) {
    if (ENVELOPE_FIELDS.includes(key) || shown.has(key)) continue;
    lines.push(...factLines(key, value, theme));
  }
  if (report.next !== undefined) lines.push(`${theme.fg("dim", "next:")} ${report.next}`);
  return lines;
}

/** A result without its report block, for renderers that show every content block. */
export function withoutReport<T extends Pick<AgentToolResult<unknown>, "content" | "details">>(
  result: T,
): T {
  const report = (result.details as Partial<ReportDetails> | undefined)?.report;
  const last = result.content.at(-1);
  if (!report || last?.type !== "text" || last.text !== renderReport(report)) return result;
  return { ...result, content: result.content.slice(0, -1) };
}

/** Render a failure from its report; text that is not ours keeps its original lines. */
export function renderToolError(
  result: Pick<AgentToolResult<unknown>, "content" | "details">,
  theme: Theme,
  expanded: boolean,
): Text {
  const report = reportOf(result);
  const lines = report
    ? reportLines(report, theme, expanded)
    : result.content.flatMap((block) =>
        block.type === "text" && block.text
          ? block.text.split("\n").map((line) => theme.fg("error", line))
          : [],
      );
  return renderOutputPreview(lines.length ? lines : [theme.fg("error", "Error")], expanded, theme);
}

/** Facts a mutation card presents another way: the command card owns then_run. */
const MUTATION_CARD_SHOWN = new Set(["then_run", "progressError"]);

/** Render mutation status or a diff, refreshing the call header's counts in place. */
export function renderMutationResult<TArgs>(
  result: AgentToolResult<
    | {
        displayDiff?: string;
        diff?: string;
        report?: Report;
        actionFusion?: Partial<Pick<ActionFusionProgress, "publication" | "mutationCompleted">>;
      }
    | undefined
  >,
  { isPartial, expanded }: ToolRenderResultOptions,
  theme: Theme,
  context: { isError: boolean; args: TArgs; state?: MutationRenderState },
  pending: string,
  header: (args: TArgs, theme: Theme, counts?: DiffCounts) => string,
): Text {
  if (isPartial && result.details?.actionFusion?.mutationCompleted !== true)
    return new Text(theme.fg("warning", pending), 0, 0);
  if (context.isError) return renderToolError(result, theme, expanded);
  const diff: string | undefined = result.details?.displayDiff ?? result.details?.diff;
  // Refresh in place: invalidation inside a renderer re-enters updateDisplay.
  publishDiffCounts(diff, context, (counts) => {
    context.state?.callText?.setText(header(context.args, theme, counts));
  });
  const report = result.details?.report;
  const facts = report ? reportLines(report, theme, expanded, MUTATION_CARD_SHOWN) : [];
  // Only identical content produces no diff.
  const body = diff
    ? renderDiffPreview(diff, expanded, theme)
    : theme.fg("success", "No net change");
  return new Text([body, ...facts].join("\n"), 0, 0);
}
