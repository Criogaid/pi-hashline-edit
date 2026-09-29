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
 * interleave. Regex batches run in a cancellable worker with a time limit.
 *
 * @module pi-hashline-edit/pi
 */

import {
  type ExtensionContext,
  type Theme,
  type ToolDefinition,
  type ToolRenderResultOptions,
} from "@earendil-works/pi-coding-agent";
import type { AgentToolResult, AgentToolUpdateCallback } from "@earendil-works/pi-agent-core";
import { Type, type Static } from "typebox";
import { Worker } from "node:worker_threads";
import { splitLines } from "../core/lines.ts";
import { applyReplacements } from "./replace-apply.ts";
import { ACTION_FUSION_GUIDELINES, withThenRunSchema, type ThenRunInput } from "./action-fusion.ts";
import { createAnchorFormatter, type AnchorFormatter } from "./anchor-format.ts";
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
type ReplaceDetails = TextMutationDetails;
type ReplaceRenderContext = Parameters<
  NonNullable<ToolDefinition<typeof replaceSchema>["renderCall"]>
>[2];

const replacementSchema = Type.Object(
  {
    find: Type.String({
      minLength: 1,
      description:
        "Text or JavaScript regex to find in the shared LF view. Actual CRLF in the file and query normalizes to LF; standalone CR stays content. In literal mode (default), an actual LF matches a line boundary, while backslash followed by n matches those two source characters. In regex mode, \\n in the pattern matches LF.",
    }),
    replace: Type.String({
      description:
        "Replacement text in the shared LF view. Restores original line endings; extra lines use the last matched ending or the file style. Literal mode keeps $ verbatim; regex mode expands JavaScript $ substitutions against the LF snapshot. Use write for explicit whole-file line-ending conversion.",
    }),
    regex: Type.Optional(
      Type.Boolean({ description: "Interpret find as a JavaScript regex (default false)." }),
    ),
    flags: Type.Optional(
      Type.String({
        pattern: "^[gimsuyd]*$",
        description:
          "Regex flags in either mode; g is always added. For regex patterns, use 'm' to make ^ and $ match line boundaries.",
      }),
    ),
  },
  { additionalProperties: false },
);
type Replacement = Static<typeof replacementSchema>;

const replaceSchema = Type.Object(
  {
    path: Type.String({
      minLength: 1,
      description: "Path to the file to edit (relative or absolute)",
    }),
    replacements: Type.Array(replacementSchema, {
      minItems: 1,
      description:
        "Rules matched against one original snapshot. Overlaps or any zero-match rule reject the entire call.",
    }),
  },
  { additionalProperties: false },
);

function createReplaceSchema(actionFusion: boolean) {
  return withThenRunSchema(
    replaceSchema,
    "Command to run once after all replacements succeed; failure does not roll back the replacement.",
    actionFusion,
  );
}
type ReplaceParams = Static<typeof replaceSchema> & { then_run?: ThenRunInput };

const REGEX_TIMEOUT_MS = 5_000;

async function applyRegexReplacements(
  source: string,
  rules: readonly Replacement[],
  signal: AbortSignal | undefined,
): Promise<{ text: string; count: number }> {
  signal?.throwIfAborted();
  const worker = new Worker(new URL("./replace-worker.mjs", import.meta.url), {
    workerData: { source, rules },
  });
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (result: { text: string; count: number } | Error, terminate = false) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      const complete = () => (result instanceof Error ? reject(result) : resolve(result));
      if (terminate) void worker.terminate().then(complete, reject);
      else complete();
    };
    const abort = () => finish(new Error("aborted before apply."), true);
    const timer = setTimeout(
      () => finish(new Error(`regex evaluation timed out after ${REGEX_TIMEOUT_MS}ms`), true),
      REGEX_TIMEOUT_MS,
    );
    worker.on(
      "message",
      (message: { result?: { text: string; count: number }; error?: string }) => {
        if (message.error !== undefined) finish(new Error(message.error));
        else if (message.result) finish(message.result);
        else finish(new Error("Regex worker returned an invalid result"));
      },
    );
    worker.on("error", (error) =>
      finish(error instanceof Error ? error : new Error(String(error))),
    );
    worker.on("exit", (code) => finish(new Error(`Regex worker exited with code ${code}`)));
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
  });
}
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

export function makeReplaceTool(cwd: string, fusion?: ActionFusionExecutor) {
  const parameters = createReplaceSchema(fusion !== undefined);
  return {
    name: "replace" as const,
    label: "replace",
    description:
      "Replace all matching text across a file using one or more replacement rules. All rules match the original snapshot; overlaps or any zero-match rule reject the entire call. Supports literal strings and JavaScript regex. Returns a diff and fresh anchors.",
    promptSnippet: "Replace matching text across a file",
    promptGuidelines: [
      "Use replace for bulk changes; prefer edit for a specific, anchor-verified location.",
      ...(fusion ? ACTION_FUSION_GUIDELINES : []),
    ],
    parameters,
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
      ctx: ExtensionContext,
    ) {
      return executeMutation<Omit<ReplaceParams, "then_run">, ReplaceDetails>(
        {
          name: "replace",
          cwd,
          parameters,
          fusion,
          reportsAnchors: true,
          run: (mutationParams, target) => runReplace(target, mutationParams.replacements),
        },
        { toolCallId, params, signal, onUpdate, ctx },
      );
    },
  };
}

function runReplace(target: MutationTarget, rules: ReplaceParams["replacements"]) {
  const anchorFormatter = createAnchorFormatter();

  return runTextMutation("replace", target, async (currentText) => {
    let newText: string;
    let count: number;
    try {
      ({ text: newText, count } = rules.some((rule) => rule.regex === true)
        ? await applyRegexReplacements(currentText, rules, target.signal)
        : applyReplacements(currentText, rules));
    } catch (error) {
      throw new Error(
        `Replace ${target.displayPath}: ${error instanceof Error ? error.message : String(error)}`,
      );
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
