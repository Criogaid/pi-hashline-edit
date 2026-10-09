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
import type { ActionFusionProgress } from "./action-fusion.ts";
import { parseArgumentError, type ArgumentError } from "./argument-error.ts";

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

/** Both direct and nested mutation cards retain the final stale-target warning. */
export function renderFreshnessWarning(
  freshness: ActionFusionProgress["freshness"] | undefined,
  theme: Theme,
): Text | undefined {
  return freshness === "changed" || freshness === "missing"
    ? new Text(theme.fg("warning", `Anchors are stale: target ${freshness}.`), 0, 0)
    : undefined;
}

/** Present the serialized model diagnostic without its transport fields or argument echo. */
function argumentErrorLines(error: ArgumentError, theme: Theme, expanded: boolean): string[] {
  const lines = [theme.fg("error", theme.bold(`Invalid arguments · ${error.tool} not executed`))];
  // Keep source omission notices ahead of the bounded collapsed preview.
  if (error.argumentsOmitted)
    lines.push(theme.fg("warning", "Prepared arguments omitted from diagnostic."));
  if (error.schemaLimited)
    lines.push(
      theme.fg("warning", "Schema diagnostic limit reached; additional issues may remain."),
    );
  if (error.omittedIssues)
    lines.push(theme.fg("warning", `${error.omittedIssues} issues omitted from diagnostic.`));
  for (const { field, reason } of error.issues) {
    const [first, ...rest] = reason.split("\n");
    lines.push(`${theme.fg("accent", theme.bold(field))}: ${theme.fg("error", first)}`);
    lines.push(...rest.map((line) => `  ${theme.fg("error", line)}`));
  }
  if (expanded && Object.hasOwn(error, "arguments")) {
    lines.push("", theme.fg("dim", "Prepared arguments:"));
    lines.push(
      ...JSON.stringify(error.arguments, null, 2)
        .split("\n")
        .map((line) => theme.fg("dim", line)),
    );
  }
  return lines;
}

/** Preserve diagnostic causes and recovery hints from every text block. */
export function renderToolError(
  result: Pick<AgentToolResult<unknown>, "content">,
  theme: Theme,
  expanded: boolean,
): Text {
  const lines = result.content.flatMap((block) => {
    if (block.type !== "text" || !block.text) return [];
    const diagnostic = parseArgumentError(block.text);
    return diagnostic
      ? argumentErrorLines(diagnostic, theme, expanded)
      : block.text.split("\n").map((line) => theme.fg("error", line));
  });
  return renderOutputPreview(lines.length ? lines : [theme.fg("error", "Error")], expanded, theme);
}

/** Render mutation status or a diff, refreshing the call header's counts in place. */
export function renderMutationResult<TArgs>(
  result: AgentToolResult<{
    displayDiff?: string;
    diff?: string;
    actionFusion?: Partial<Pick<ActionFusionProgress, "publication" | "mutationCompleted">>;
  }>,
  { isPartial, expanded }: ToolRenderResultOptions,
  theme: Theme,
  context: { isError: boolean; args: TArgs; state?: MutationRenderState },
  pending: string,
  fallback: string,
  header: (args: TArgs, theme: Theme, counts?: DiffCounts) => string,
): Text {
  if (isPartial && result.details?.actionFusion?.mutationCompleted !== true)
    return new Text(theme.fg("warning", pending), 0, 0);
  const content = result.content?.[0];
  if (context.isError) return renderToolError(result, theme, expanded);
  const diff: string | undefined = result.details?.displayDiff ?? result.details?.diff;
  // Refresh in place: invalidation inside a renderer re-enters updateDisplay.
  publishDiffCounts(diff, context, (counts) => {
    context.state?.callText?.setText(header(context.args, theme, counts));
  });
  if (!diff) {
    // Only the summary is displayed; subsequent anchor rows are for the model.
    const summary = content?.type === "text" ? content.text.split("\n")[0] : fallback;
    return new Text(theme.fg("success", summary), 0, 0);
  }
  return new Text(renderDiffPreview(diff, expanded, theme), 0, 0);
}
