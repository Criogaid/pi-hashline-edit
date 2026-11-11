/**
 * Override grep: valid UTF-8 results feed edit; malformed UTF-8 uses non-editable previews.
 * grep-scope admits paths, grep-candidates selects candidates with rg, grep-search matches
 * them with native JavaScript (core/search), grep-output states the payload and every report
 * fact, and grep-render draws the card. This module owns the schema and execution order.
 * @module pi-hashline-edit/pi
 */

import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { Text } from "@earendil-works/pi-tui";
import { renderOutputPreview, renderToolError, reportLines, splitReport } from "./render.ts";
import { createAnchorFormatter } from "./anchor-format.ts";
import { GREP_OUTPUT_MODES, grepOutput, type GrepOutputMode } from "./grep-output.ts";
import { filterExplicitFilesByGlob, resolveSearchPaths } from "./grep-scope.ts";
import { searchFiles } from "./grep-search.ts";
import { toDisplayLines } from "./grep-render.ts";
import { smartIgnoreCase } from "../core/search-analysis.ts";
import { checkRegexArguments } from "../core/regex.ts";
import { DEFAULT_GREP_FLAGS } from "../core/search.ts";
import {
  GREP_CONTEXT_RANGE,
  literalUnion,
  POSITIVE_SAFE_INTEGER,
  STRICT_SAMPLING,
} from "./schema.ts";
import { throwIfCancelled } from "./error-text.ts";
import { reportResult, runTool, type ReportDetails } from "./report.ts";
import type { HashlineEditConfig, ToolEnvironment } from "./config.ts";
import { createArgumentPreparer, type ReportArgumentIssue } from "./argument-validation.ts";

/** A list field: arrays only, because strict sampling cannot take a string-or-array union. */
const nonEmptyStrings = (description: string) =>
  Type.Array(Type.String({ minLength: 1 }), { minItems: 1, description });

/** What each output mode returns; argument diagnostics list these beside the values. */
const OUTPUT_MODE_MEANING: Record<GrepOutputMode, string> = {
  content:
    "Default. Matches and context, with anchors for valid UTF-8 or plain previews otherwise.",
  files: "Paths of the files with a match; use it when only paths are needed.",
  count: "Matching lines per file and in total; use it when only counts are needed.",
};

/** Grep parameters; descriptions state the configured defaults. */
function createGrepSchema({ defaultLimit, defaultContext }: HashlineEditConfig["grep"]) {
  return Type.Object(
    {
      pattern: nonEmptyStrings(
        "Patterns; a line matches if any of them matches. With literal true, | is an ordinary character, so give alternatives as separate items. Regex syntax is JavaScript, as in replace.",
      ),
      path: Type.Optional(
        nonEmptyStrings(
          "Existing files or directories; omit to search the working directory. Wildcards are not expanded.",
        ),
      ),
      glob: Type.Optional(
        nonEmptyStrings(
          "Filename wildcards go here, not in path: ordered globs; prefix exclusions with !, e.g. ['*.ts', '!**/*.test.ts'].",
        ),
      ),
      literal: Type.Boolean({
        description:
          "true: match the text exactly, including regex punctuation; use it for names, paths, and code snippets. false: JavaScript regex, where foo(0) matches foo0; use it only for an intentional regex.",
      }),
      flags: Type.Optional(
        Type.String({
          description: `JavaScript regex flags (default ${DEFAULT_GREP_FLAGS}); given flags replace the default, so in a multiline search without m, ^ and $ anchor to the file's start and end. g is always enabled and repeated flags are ignored. Use u or v for Unicode mode, s for dotAll, and y for sticky matching.`,
        }),
      ),
      ignoreCase: Type.Optional(
        Type.Boolean({
          description:
            "true ignores case, false matches case; overrides the i flag. When omitted, the i flag ignores case; without it, case is ignored only when no pattern contains an uppercase letter (a pattern that cannot be analyzed counts as uppercase).",
        }),
      ),
      multiline: Type.Optional(
        Type.Boolean({
          description:
            "Match across lines (default false); content mode returns every line a match touches. \\n matches LF and CRLF.",
        }),
      ),
      context: Type.Optional(
        Type.Number({
          ...GREP_CONTEXT_RANGE,
          description: `Lines shown before and after each match (${GREP_CONTEXT_RANGE.minimum}-${GREP_CONTEXT_RANGE.maximum}, default ${defaultContext}); display only, not matched. Use 3-5 when searching code to edit.`,
        }),
      ),
      limit: Type.Optional(
        Type.Number({
          ...POSITIVE_SAFE_INTEGER,
          description: `Maximum matching lines, across all files (default ${defaultLimit}). Every outputMode counts them the same way, so files and count stop at the same cutoff as content.`,
        }),
      ),
      outputMode: Type.Optional(
        literalUnion(GREP_OUTPUT_MODES, (mode) => OUTPUT_MODE_MEANING[mode]),
      ),
    },
    { additionalProperties: false },
  );
}
type GrepSchema = ReturnType<typeof createGrepSchema>;
type GrepTool = ToolDefinition<GrepSchema, Partial<ReportDetails> | undefined>;
/** A list field as the call header sees it: streamed before Pi wraps a lone string. */
function streamedList(value: string | readonly string[] | null | undefined): readonly string[] {
  return value == null ? [] : typeof value === "string" ? [value] : value;
}

/** Validate JavaScript syntax once; the search never rejects a pattern V8 accepts. */
function checkGrepArguments(args: unknown, report: ReportArgumentIssue): void {
  const { pattern, literal, flags } = (args ?? {}) as Record<string, unknown>;
  if (
    !Array.isArray(pattern) ||
    typeof literal !== "boolean" ||
    (flags !== undefined && typeof flags !== "string")
  )
    return;
  const fields = pattern.map((value, index) => [`pattern[${index}]`, value] as const);
  checkRegexArguments("flags", flags ?? DEFAULT_GREP_FLAGS, literal, fields, report);
}

/** Build the grep override (a ToolDefinition fragment for registerTool). */
export function makeGrepOverride({ cwd, config, budgets }: ToolEnvironment) {
  const { hashLen } = config;
  const grepSchema = createGrepSchema(config.grep);

  return {
    name: "grep" as const,
    label: "grep",
    description:
      "Search file contents. Content mode returns LINE#HASH edit anchors for valid UTF-8 and plain line numbers without anchors otherwise; files/count modes return paths or matching-line counts. NUL-containing files are skipped. Directory searches respect ignore rules and skip .git and linked directories, even beneath a directory named in path; to search an ignored file or one of those directories, name it itself in path. Use grep instead of rg or grep in a shell to search files; use the shell only to filter another command's output.",
    promptSnippet: "Search file contents",
    promptGuidelines: [
      "When you need several independent searches, send them as separate grep calls in one response; they run in parallel.",
      "Copy grep anchors directly into edit.",
    ],
    parameters: grepSchema,
    prepareArguments: createArgumentPreparer("grep", grepSchema, checkGrepArguments, budgets),
    constrainedSampling: STRICT_SAMPLING,

    renderShell: "default" as const,

    renderCall(
      args: Static<GrepSchema>,
      theme: Parameters<NonNullable<GrepTool["renderCall"]>>[1],
    ) {
      const paths = streamedList(args?.path);
      const globs = streamedList(args?.glob);
      let text =
        theme.fg("toolTitle", theme.bold("grep ")) +
        theme.fg("accent", `/${streamedList(args?.pattern).join(" | ")}/${args?.flags ?? ""}`) +
        theme.fg("toolOutput", ` in ${paths.length ? paths.join(" ") : "."}`);
      if (globs.length) text += theme.fg("toolOutput", ` (${globs.join(", ")})`);
      if (args?.outputMode && args.outputMode !== "content")
        text += theme.fg("success", ` → ${args.outputMode}`);
      // Strict sampling streams unused optional fields as null.
      if (args?.limit != null) text += theme.fg("toolOutput", ` limit ${args.limit}`);
      return new Text(text, 0, 0);
    },

    renderResult(
      result: Parameters<NonNullable<GrepTool["renderResult"]>>[0],
      { isPartial, expanded }: Parameters<NonNullable<GrepTool["renderResult"]>>[1],
      theme: Parameters<NonNullable<GrepTool["renderResult"]>>[2],
      context: Parameters<NonNullable<GrepTool["renderResult"]>>[3],
    ) {
      if (isPartial) return new Text(theme.fg("warning", "Searching…"), 0, 0);
      if (context.isError) return renderToolError(result, "grep", theme, expanded);
      const { content, report } = splitReport(result, "grep");
      const payload = content[0];
      const mode = context.args?.outputMode ?? "content";
      const lines =
        payload?.type !== "text"
          ? []
          : mode === "content"
            ? toDisplayLines(payload.text, theme)
            : payload.text.split("\n").map((line) => theme.fg("toolOutput", line));
      return renderOutputPreview(
        [...lines, ...(report ? reportLines(report, theme) : [])],
        expanded,
        theme,
      );
    },

    async execute(
      _toolCallId: string,
      params: Static<GrepSchema>,
      signal: AbortSignal | undefined,
    ) {
      const budget = budgets();
      return runTool("grep", { path: params.path, signal, budget }, async () => {
        throwIfCancelled(signal);
        const patterns = params.pattern;
        const effectiveLimit = params.limit ?? config.grep.defaultLimit;
        const outputMode = params.outputMode ?? "content";
        const { literal } = params;
        const flags = new Set(params.flags ?? DEFAULT_GREP_FLAGS);
        const ignoreCase =
          params.ignoreCase ??
          (flags.has("i") || smartIgnoreCase(patterns, literal, [...flags].join("")));
        if (ignoreCase) flags.add("i");
        else flags.delete("i");
        const query = {
          patterns,
          literal,
          flags: [...flags].join(""),
          multiline: params.multiline ?? false,
        };
        const globs = params.glob ?? [];
        const paths = await resolveSearchPaths(cwd, params.path);
        const admitted = await filterExplicitFilesByGlob(globs, paths, signal);
        const { warnings: searchWarnings, ...search } = await searchFiles({
          scope: { globs, searchPaths: admitted.searchPaths },
          query,
          limit: effectiveLimit,
          timeoutMs: config.grep.regexTimeoutMs,
          signal,
        });
        const { payload, facts } = await grepOutput({
          cwd,
          search,
          outputMode,
          context: params.context ?? config.grep.defaultContext,
          anchors: createAnchorFormatter(hashLen),
          signal,
          // Each stage returns its warnings in order; the report states them in stage order.
          warnings: [...admitted.warnings, ...searchWarnings],
          effectiveLimit,
          literalPipe: literal && patterns.some((pattern) => pattern.includes("|")),
          budget,
        });
        return reportResult(
          { tool: "grep" as const, path: params.path, ...facts },
          payload === undefined ? [] : [{ type: "text" as const, text: payload }],
        );
      });
    },
  } satisfies GrepTool;
}
