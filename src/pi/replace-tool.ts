/**
 * `replace`: bulk literal text replacement or
 * full JavaScript regex with capture-group substitution.
 *
 * Distinct from the anchor-verified `edit`. `replace` is **location-blind**:
 * it matches `find` everywhere across the whole file and substitutes every
 * occurrence. Use it for renames and pattern-based transforms that would
 * otherwise need many individual edits. For a single surgical, verified change,
 * prefer `edit`.
 *
 * - Both modes match the shared LF view and restore original line separators.
 * - Literal mode keeps `$` verbatim; regex mode expands JavaScript replacement tokens.
 * - `flags` adds regex flags in either mode; `g` is always forced so every
 *   occurrence is replaced. `i` (case-insensitive), `m` (per-line ^/$),
 *   `s` (dotall), `u` (unicode) all work.
 * - `replacements` batches rules against one original snapshot; conflicting
 *   ranges or a failing rule reject the entire batch before publication.
 *
 * Concurrency: read-modify-write is wrapped in Pi's withFileMutationQueue
 * (shared with `edit`), so a `replace` and an `edit` on the same file never
 * interleave. Regex batches run in a cancellable worker with a time limit (replace-regex).
 *
 * @module pi-hashline-edit/pi
 */

import {
  type ExtensionToolContext,
  type Theme,
  type ToolDefinition,
  type ToolRenderResultOptions,
} from "@earendil-works/pi-coding-agent";
import type { AgentToolResult, AgentToolUpdateCallback } from "@earendil-works/pi-agent-core";
import { Type, type Static } from "typebox";
import { splitLines } from "../core/lines.ts";
import { applyReplacements, buildRegex } from "../core/replace.ts";
import { runRegexReplacements } from "./replace-regex.ts";
import { unwritableTextReason } from "../core/text.ts";
import { ACTION_FUSION_GUIDELINES, withThenRunSchema, type ThenRunInput } from "./action-fusion.ts";
import { createAnchorFormatter, type AnchorFormatter } from "./anchor-format.ts";
import type { HashlineEditConfig } from "./config.ts";
import {
  formatDiffCounts,
  renderMutationCall,
  renderMutationResult,
  type DiffCounts,
} from "./render.ts";
import { formatMutationAnchors } from "./mutation-result.ts";
import {
  executeMutation,
  runTextMutation,
  type ActionFusionExecutor,
  type MutationTarget,
  type TextMutationDetails,
} from "./mutation-runner.ts";
import { MUTATION_TOOL_GUIDELINE } from "./tool-prompts.ts";
import { errorMessage } from "../core/errors.ts";
import { throwIfCancelled } from "./error-text.ts";
import {
  argumentItems,
  createArgumentPreparer,
  type ReportArgumentIssue,
} from "./argument-validation.ts";
type ReplaceDetails = TextMutationDetails;
type ReplaceRenderContext = Parameters<
  NonNullable<ToolDefinition<typeof replaceSchema>["renderCall"]>
>[2];

const REGEX_FLAGS_PATTERN = "^[gimsuyd]*$";

const replacementSchema = Type.Object(
  {
    find: Type.String({
      minLength: 1,
      description:
        "Text, or a JavaScript regex when regex is true. CRLF in the file reads as LF, so a line break is \\n; in literal mode a backslash followed by n matches those two characters. In regex mode, ^ and $ need the m flag to match per line; \\d, \\w, and \\b are ASCII-based.",
    }),
    replace: Type.String({
      description:
        "Replacement text; the file's line endings are kept. Literal mode keeps $ as is; regex mode expands $1, $<name>, and $&.",
    }),
    regex: Type.Optional(
      Type.Boolean({ description: "Treat find as a JavaScript regex (default false)." }),
    ),
    flags: Type.Optional(
      Type.String({
        pattern: REGEX_FLAGS_PATTERN,
        description: "Extra regex flags, also applied in literal mode; g is always added.",
      }),
    ),
  },
  { additionalProperties: false },
);

const replaceSchema = Type.Object(
  {
    path: Type.String({
      minLength: 1,
      description: "Path to the file (relative or absolute)",
    }),
    replacements: Type.Array(replacementSchema, {
      minItems: 1,
      description: "Rules applied to the original content; inserted text is not searched again.",
    }),
  },
  { additionalProperties: false },
);

function createReplaceSchema(actionFusion: boolean) {
  return withThenRunSchema(replaceSchema, "replace", actionFusion);
}
type ReplaceParams = Static<typeof replaceSchema> & { then_run?: ThenRunInput };

/**
 * Bound candidate anchors by stripping common prefix/suffix lines in O(n).
 * For a pure deletion, retain its first surviving successor. Shifted suffixes
 * are otherwise omitted; the shared formatter removes unchanged positions.
 */
function anchorSpan(
  oldLines: readonly string[],
  newLines: readonly string[],
): { start: number; end: number; contextLines: number[] } | null {
  const n = Math.min(oldLines.length, newLines.length);
  let prefix = 0;
  while (prefix < n && oldLines[prefix] === newLines[prefix]) prefix++;
  // same length and fully equal → no change
  if (oldLines.length === newLines.length && prefix === oldLines.length) return null;
  let oldSuffix = 0;
  let newSuffix = 0;
  while (
    oldSuffix < oldLines.length - prefix &&
    newSuffix < newLines.length - prefix &&
    oldLines[oldLines.length - 1 - oldSuffix] === newLines[newLines.length - 1 - newSuffix]
  ) {
    oldSuffix++;
    newSuffix++;
  }
  const start = prefix;
  const end = newLines.length - 1 - newSuffix; // inclusive, 0-based, in new
  return start >= newLines.length
    ? null
    : { start, end: Math.max(start, end), contextLines: end < start ? [start] : [] };
}

/** Format changed positions within the candidate span, subject to the shared output budget. */
function formatSpanAnchors(
  oldLines: readonly string[],
  newLines: readonly string[],
  span: NonNullable<ReturnType<typeof anchorSpan>>,
  anchors: AnchorFormatter,
): string {
  function* indices() {
    for (let i = span.start; i <= span.end; i++) yield i;
  }
  return formatMutationAnchors(
    oldLines,
    newLines,
    indices(),
    anchors,
    "Updated anchors:",
    new Set(span.contextLines),
  );
}

/** Call-header line: `replace path — N rules`, plus `+N -N` once diff counts are known. */
function replaceHeader(args: ReplaceParams, theme: Theme, counts?: DiffCounts): string {
  let t = theme.fg("toolTitle", theme.bold("replace "));
  t += theme.fg("accent", args.path);
  const count = args.replacements?.length ?? 0;
  t += theme.fg("dim", ` — ${count} rule${count === 1 ? "" : "s"}`);
  if (counts && (counts.added || counts.removed)) t += formatDiffCounts(counts, theme);
  return t;
}

/** Report unwritable replacement text and regex compile errors; Pi checks field shapes. */
function checkReplaceArguments(args: unknown, report: ReportArgumentIssue): void {
  const rules = argumentItems((args as { replacements?: unknown } | null)?.replacements);
  const validFlags = new RegExp(REGEX_FLAGS_PATTERN);
  rules.forEach((rule, index) => {
    const { find, replace, regex, flags } = (rule ?? {}) as Record<string, unknown>;
    const reason = typeof replace === "string" ? unwritableTextReason(replace) : undefined;
    if (reason) report(`replacements[${index}].replace`, reason);
    if (
      regex === true &&
      typeof find === "string" &&
      find !== "" &&
      (flags === undefined || (typeof flags === "string" && validFlags.test(flags)))
    ) {
      try {
        buildRegex(find, true, flags);
      } catch (error) {
        report(`replacements[${index}].find`, errorMessage(error));
      }
    }
  });
}

export function makeReplaceTool(
  cwd: string,
  config: HashlineEditConfig,
  fusion?: ActionFusionExecutor,
) {
  const parameters = createReplaceSchema(fusion !== undefined);
  return {
    name: "replace" as const,
    label: "replace",
    description:
      "Replace every match of one or more literal or JavaScript-regex rules in a file. Overlapping matches or a rule with no match reject the whole call. Returns a diff and fresh anchors.",
    promptSnippet: "Replace matching text across a file",
    promptGuidelines: [MUTATION_TOOL_GUIDELINE, ...(fusion ? ACTION_FUSION_GUIDELINES : [])],
    parameters,
    prepareArguments: createArgumentPreparer("replace", parameters, checkReplaceArguments),
    renderShell: "default" as const,

    renderCall(args: ReplaceParams, theme: Theme, context: ReplaceRenderContext) {
      return renderMutationCall(args, theme, context, replaceHeader);
    },

    renderResult(
      result: AgentToolResult<ReplaceDetails>,
      options: ToolRenderResultOptions,
      theme: Theme,
      context: ReplaceRenderContext,
    ) {
      return renderMutationResult(
        result,
        options,
        theme,
        context,
        "Replacing…",
        "Replaced",
        replaceHeader,
      );
    },

    async execute(
      toolCallId: string,
      params: ReplaceParams & { then_run?: ThenRunInput },
      signal: AbortSignal | undefined,
      onUpdate: AgentToolUpdateCallback<ReplaceDetails> | undefined,
      ctx: ExtensionToolContext,
    ) {
      return executeMutation<Omit<ReplaceParams, "then_run">, ReplaceDetails>(
        {
          cwd,
          fusion,
          run: (mutationParams, target) => runReplace(target, mutationParams.replacements, config),
        },
        { toolCallId, params, signal, onUpdate, ctx },
      );
    },
  };
}

function runReplace(
  target: MutationTarget,
  rules: ReplaceParams["replacements"],
  config: HashlineEditConfig,
) {
  const anchorFormatter = createAnchorFormatter(config.hashLen);

  return runTextMutation("replace", target, async (currentText) => {
    let newText: string;
    let count: number;
    try {
      ({ text: newText, count } = rules.some((rule) => rule.regex === true)
        ? await runRegexReplacements(
            currentText,
            rules,
            config.replace.regexTimeoutMs,
            target.signal,
          )
        : applyReplacements(currentText, rules));
    } catch (error) {
      throwIfCancelled(target.signal, `before apply; ${target.displayPath} was not changed.`);
      throw new Error(`Replace ${target.displayPath}: ${errorMessage(error)}`);
    }
    const changed = newText !== currentText;

    return {
      text: newText,
      anchors: () => {
        const oldLines = splitLines(currentText);
        const newLines = splitLines(newText);
        const span = changed ? anchorSpan(oldLines, newLines) : null;
        return span ? formatSpanAnchors(oldLines, newLines, span, anchorFormatter) : "";
      },
      summary: () => {
        const matchWord = `match${count !== 1 ? "es" : ""}`;
        const note = changed ? `${count} ${matchWord}` : `${count} ${matchWord}, no net change`;
        return `Replaced ${target.displayPath} (${note}).`;
      },
    };
  });
}
