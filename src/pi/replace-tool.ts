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
import { applyReplacements, buildRegex } from "../core/replace.ts";
import { REPLACEMENTS_SCHEMA, REGEX_FLAGS_PATTERN } from "../core/replace-schema.ts";
import { runRegexReplacements } from "./replace-regex.ts";
import { unwritableTextError } from "../core/text.ts";
import { ACTION_FUSION_GUIDELINES, withThenRunSchema, type ThenRunInput } from "./action-fusion.ts";
import type { HashlineEditConfig } from "./config.ts";
import {
  formatDiffCounts,
  renderMutationCall,
  renderMutationResult,
  type DiffCounts,
} from "./render.ts";
import {
  executeMutation,
  runTextMutation,
  type ActionFusionExecutor,
  type MutationTarget,
  type TextMutationDetails,
} from "./mutation-runner.ts";
import { MUTATION_TOOL_GUIDELINE } from "./tool-prompts.ts";
import { errorMessage } from "../core/errors.ts";
import { defaultOutputBudgets, type OutputBudgetProvider } from "./budgets.ts";
import { cancellationError } from "./error-text.ts";
import {
  argumentItems,
  createArgumentPreparer,
  type ReportArgumentIssue,
} from "./argument-validation.ts";
type ReplaceDetails = TextMutationDetails;
type ReplaceRenderContext = Parameters<
  NonNullable<ToolDefinition<typeof replaceSchema>["renderCall"]>
>[2];

const replaceSchema = Type.Object(
  {
    path: Type.String({
      minLength: 1,
      description: "Path to the file (relative or absolute)",
    }),
    replacements: REPLACEMENTS_SCHEMA,
  },
  { additionalProperties: false },
);

function createReplaceSchema(actionFusion: boolean) {
  return withThenRunSchema(replaceSchema, "replace", actionFusion);
}
type ReplaceParams = Static<typeof replaceSchema> & { then_run?: ThenRunInput };

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
    const unwritable = typeof replace === "string" ? unwritableTextError(replace) : undefined;
    if (unwritable) report(`replacements[${index}].replace`, unwritable.message);
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
  budgets: OutputBudgetProvider = defaultOutputBudgets,
) {
  const parameters = createReplaceSchema(fusion !== undefined);
  return {
    name: "replace" as const,
    label: "replace",
    description:
      "Replace every match of one or more literal or JavaScript-regex rules in a file. Overlapping matches or a rule with no match reject the whole call. Returns a mutation report.",
    promptSnippet: "Replace matching text across a file",
    promptGuidelines: [MUTATION_TOOL_GUIDELINE, ...(fusion ? ACTION_FUSION_GUIDELINES : [])],
    parameters,
    prepareArguments: createArgumentPreparer("replace", parameters, checkReplaceArguments, budgets),
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
      return renderMutationResult(result, options, theme, context, "Replacing…", replaceHeader);
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
          tool: "replace",
          cwd,
          fusion,
          budgets,
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
  return runTextMutation(target, async (currentText) => {
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
      if (target.signal?.aborted) throw cancellationError();
      throw error;
    }
    return {
      text: newText,
      facts: { matches: count },
    };
  });
}
