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
 * Concurrency: read-modify-write is wrapped in {@link withFileMutationQueue}
 * (shared with `edit`), so a `replace` and an `edit` on the same file never
 * interleave. Regex batches run in a cancellable worker with a time limit.
 *
 * @module pi-hashline-edit/pi
 */

import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { Worker } from "node:worker_threads";
import { splitLines } from "../core/lines.ts";
import { applyReplacements } from "./replace-apply.ts";
import {
  ACTION_FUSION_GUIDELINES,
  createActionFusionExecutor,
  createThenRunSchema,
  type ThenRunInput,
} from "./action-fusion.ts";
import { readEditableSnapshot, commitReplacement } from "./file-commit.ts";
import { createAnchorFormatter, type AnchorFormatter } from "./anchor-format.ts";
import { canonicalPath } from "./path.ts";
import {
  formatDiffCounts,
  renderMutationCall,
  renderMutationResult,
  type DiffCounts,
} from "./render.ts";
import {
  appendMutationAnchors,
  finalizeMutationResult,
  formatMutationAnchors,
  generateMutationDetails,
  postProcessMutation,
} from "./mutation-result.ts";

const replacementSchema = Type.Object({
  find: Type.String({
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
      description:
        "Regex flags in either mode; g is always added. For regex patterns, use 'm' to make ^ and $ match line boundaries.",
    }),
  ),
});
type Replacement = Static<typeof replacementSchema>;

function createReplaceSchema(actionFusion: boolean) {
  return Type.Object({
    path: Type.String({ description: "Path to the file to edit (relative or absolute)" }),
    ...Type.Partial(replacementSchema).properties,
    replacements: Type.Optional(
      Type.Array(replacementSchema, {
        minItems: 1,
        description:
          "Rules matched against one original snapshot. Mutually exclusive with top-level find/replace/regex/flags. Overlaps reject the entire batch.",
      }),
    ),
    ...(actionFusion
      ? {
          then_run: createThenRunSchema(
            "Command to run once after all replacements succeed; failure does not roll back the replacement.",
          ),
        }
      : {}),
  });
}

const replaceSchema = createReplaceSchema(false);
type ReplaceParams = Omit<Static<typeof replaceSchema>, "then_run"> & { then_run?: ThenRunInput };

function replacementRules(params: ReplaceParams): Replacement[] {
  if (
    params.replacements !== undefined &&
    Object.keys(replacementSchema.properties).some(
      (key) => params[key as keyof Replacement] !== undefined,
    )
  ) {
    throw new Error("replacements cannot be combined with top-level replacement fields");
  }
  const rules = params.replacements ?? [params];
  if (!Array.isArray(rules) || rules.length === 0)
    throw new Error("replacements must be a non-empty array");
  for (const [index, rule] of rules.entries()) {
    if (!rule || typeof rule.find !== "string" || typeof rule.replace !== "string")
      throw new Error(`rule ${index}: find and replace must be strings`);
    if (rule.find === "") throw new Error(`rule ${index}: \`find\` is empty`);
    if (rule.regex !== undefined && typeof rule.regex !== "boolean")
      throw new Error(`rule ${index}: regex must be a boolean`);
    if (rule.flags !== undefined && typeof rule.flags !== "string")
      throw new Error(`rule ${index}: flags must be a string`);
  }
  return rules as Replacement[];
}

const REGEX_TIMEOUT_MS = 5_000;

async function applyRegexReplacements(
  source: string,
  rules: readonly Replacement[],
  signal: AbortSignal | undefined,
  displayPath: string,
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
    const abort = () => finish(new Error(`Replace ${displayPath} aborted before apply.`), true);
    const timer = setTimeout(
      () =>
        finish(
          new Error(
            `Replace ${displayPath}: regex evaluation timed out after ${REGEX_TIMEOUT_MS}ms`,
          ),
          true,
        ),
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

/** Truncate a string for one-line display, folding newlines into a marker. */
function show(s: string, n = 30): string {
  const folded = s.replace(/\n/g, "⏎");
  return folded.length > n ? folded.slice(0, n) + "…" : folded;
}

/** Call-header line: `replace path — mode "find" → "replace"`, plus `+N -N` once the result's diff counts are known. */
function replaceHeader(args: ReplaceParams, theme: any, counts?: DiffCounts): string {
  let t = theme.fg("toolTitle", theme.bold("replace "));
  t += theme.fg("accent", args.path);
  if (args.replacements) {
    t += theme.fg("dim", ` — ${args.replacements.length} rules`);
  } else {
    const mode = args.regex ? "regex" : "lit";
    const f = args.flags ? `/${args.flags}` : "";
    t += theme.fg(
      "dim",
      ` — ${mode}${f} "${show(args.find ?? "")}" → "${show(args.replace ?? "")}"`,
    );
  }
  if (counts && (counts.added || counts.removed)) t += formatDiffCounts(counts, theme);
  return t;
}

export function prepareReplaceArguments(input: unknown): unknown {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return input;
  }
  const args = { ...(input as Record<string, unknown>) };
  if (typeof args.replacements === "string") {
    try {
      const parsed = JSON.parse(args.replacements);
      if (Array.isArray(parsed)) {
        args.replacements = parsed;
      } else if (parsed && typeof parsed === "object") {
        args.replacements = [parsed];
      }
    } catch {}
  }
  return args;
}

export function makeReplaceTool(
  cwd: string,
  fusion?: ReturnType<typeof createActionFusionExecutor>,
): any {
  const parameters = createReplaceSchema(fusion !== undefined);
  return {
    name: "replace" as const,
    label: "replace",
    description:
      "Replace all matching text across a file with one rule or a replacements batch. All rules match the original snapshot; overlaps or any zero-match rule reject the entire call. Supports literal strings and JavaScript regex. Returns a diff and fresh anchors.",
    promptSnippet: "Replace matching text across a file",
    promptGuidelines: [
      "Use replace for bulk changes; prefer edit for a specific, anchor-verified location.",
      ...(fusion ? ACTION_FUSION_GUIDELINES : []),
    ],
    parameters,
    prepareArguments: prepareReplaceArguments,
    renderShell: "default" as const,

    renderCall(args: ReplaceParams & { then_run?: ThenRunInput }, theme: any, context: any) {
      return renderMutationCall(args, theme, context, replaceHeader);
    },

    renderResult(result: any, options: any, theme: any, context: any) {
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
      onUpdate: any,
      ctx: any,
    ) {
      const prepared = prepareReplaceArguments(params) as ReplaceParams & {
        then_run?: ThenRunInput;
      };
      const { then_run, ...mutationParams } = prepared;
      if (!fusion && then_run !== undefined)
        throw new Error("then_run is unavailable because hashlineEdit.actionFusion is disabled");
      const path = mutationParams.path;
      const absolutePath = canonicalPath(cwd, path);
      let mutationAnchors = "";
      const mutate = () =>
        withFileMutationQueue(absolutePath, () =>
          runReplace(absolutePath, path, mutationParams, signal, (value) => {
            mutationAnchors = value;
          }),
        );
      const finalizeMutation = (result: any, publishAnchors: boolean) =>
        appendMutationAnchors(result, mutationAnchors, publishAnchors);
      if (!fusion) return finalizeMutationResult(await mutate(), finalizeMutation);
      return fusion({
        toolCallId,
        absolutePath,
        thenRun: then_run,
        mutate,
        finalizeMutation,
        signal,
        ctx,
        onUpdate,
      });
    },
  };
}

async function runReplace(
  absPath: string,
  displayPath: string,
  params: ReplaceParams,
  signal: AbortSignal | undefined,
  onAnchors: (anchors: string) => void,
) {
  const anchorFormatter = createAnchorFormatter();
  let rules: Replacement[];
  try {
    rules = replacementRules(params);
  } catch (error) {
    throw new Error(
      `Replace ${displayPath}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const { text: currentText, baseRevision } = await readEditableSnapshot(absPath, displayPath);
  // honor cancel after read: if aborted, don't proceed to match/replace; the file stays untouched
  if (signal?.aborted) throw new Error(`Replace ${displayPath} aborted before apply.`);

  let newText: string;
  let count: number;
  try {
    ({ text: newText, count } = rules.some((rule) => rule.regex === true)
      ? await applyRegexReplacements(currentText, rules, signal, displayPath)
      : applyReplacements(currentText, rules));
  } catch (error) {
    throw new Error(
      `Replace ${displayPath}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const changed = newText !== currentText;

  // honor cancel before write: if aborted, don't touch the disk
  if (signal?.aborted) throw new Error(`Replace ${displayPath} aborted before write.`);

  const versions = await commitReplacement(absPath, displayPath, newText, baseRevision, signal);
  const { publication } = versions;

  return postProcessMutation("replace", publication, () => {
    const details = generateMutationDetails(
      displayPath,
      currentText,
      newText,
      versions,
      publication,
    );
    const oldLines = splitLines(currentText);
    const newLines = splitLines(newText);
    const span = changed ? anchorSpan(oldLines, newLines) : null;
    onAnchors(span ? formatSpanAnchors(oldLines, newLines, span, anchorFormatter) : "");
    const matchWord = `match${count !== 1 ? "es" : ""}`;
    const note = changed ? `${count} ${matchWord}` : `${count} ${matchWord}, no net change`;
    return {
      content: [{ type: "text" as const, text: `Replaced ${displayPath} (${note}).` }],
      details,
    };
  });
}
