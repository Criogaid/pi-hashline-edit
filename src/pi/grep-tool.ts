/**
 * Override grep: valid UTF-8 results feed edit; malformed UTF-8 uses non-editable previews.
 * grep-scope admits paths, grep-candidates selects candidates with rg, grep-search matches
 * them with native JavaScript (core/search), grep-output states the payload and every report
 * fact, and grep-render draws the card. This module owns the schema, backend wiring, and
 * execution order.
 * @module pi-hashline-edit/pi
 */

import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { rgPath as bundledRgPath } from "@vscode/ripgrep";
import { Type, type Static } from "typebox";
import { Text } from "@earendil-works/pi-tui";
import { renderOutputPreview, renderToolError, reportLines, withoutReport } from "./render.ts";
import { createAnchorFormatter } from "./anchor-format.ts";
import { grepOutput } from "./grep-output.ts";
import {
  filterExplicitFilesByGlob,
  toArray,
  resolveSearchPaths,
  type SearchScope,
} from "./grep-scope.ts";
import { searchFiles } from "./grep-search.ts";
import { toDisplayLines } from "./grep-render.ts";
import { runRgLines, runRgPaths, type GrepBackend } from "./rg-process.ts";
import { smartIgnoreCase } from "../core/search-analysis.ts";
import { buildRegex } from "../core/regex.ts";
import { DEFAULT_GREP_FLAGS } from "../core/search.ts";
import { errorMessage } from "../core/errors.ts";
import { GREP_CONTEXT_RANGE, POSITIVE_SAFE_INTEGER } from "./schema.ts";
import { throwIfCancelled } from "./error-text.ts";
import { reportResult, runTool, type ReportDetails } from "./report.ts";
import type { HashlineEditConfig } from "./config.ts";
import { createArgumentPreparer, type ReportArgumentIssue } from "./argument-validation.ts";
import { defaultOutputBudgets, type OutputBudgetProvider } from "./budgets.ts";

/** Grep parameters; descriptions state the configured defaults. */
function createGrepSchema({ defaultLimit, defaultContext }: HashlineEditConfig["grep"]) {
  return Type.Object(
    {
      pattern: Type.Union(
        [Type.String({ minLength: 1 }), Type.Array(Type.String({ minLength: 1 }), { minItems: 1 })],
        {
          description:
            "String or array of strings; an array matches any of them, so use it for alternatives instead of joining them with |. Regex syntax is JavaScript, as in replace.",
        },
      ),
      path: Type.Optional(
        Type.Union(
          [
            Type.String({ minLength: 1 }),
            Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }),
          ],
          {
            description:
              "Existing file or directory, or an array of them; omit to search the working directory. Wildcards are not expanded.",
          },
        ),
      ),
      glob: Type.Optional(
        Type.Union(
          [
            Type.String({ minLength: 1 }),
            Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }),
          ],
          {
            description:
              "Filename wildcards go here, not in path: a glob or an ordered array of them; prefix exclusions with !, e.g. ['*.ts', '!**/*.test.ts'].",
          },
        ),
      ),
      literal: Type.Boolean({
        description:
          "true: match the text exactly, including regex punctuation; use it for names, paths, and code snippets. false: JavaScript regex, where foo(0) matches foo0; use it only for an intentional regex.",
      }),
      flags: Type.Optional(
        Type.String({
          description: `JavaScript regex flags (default ${DEFAULT_GREP_FLAGS}); explicit flags replace the default. g is always enabled and repeated flags are ignored. Use u or v for Unicode mode, s for dotAll, and y for sticky matching.`,
        }),
      ),
      ignoreCase: Type.Optional(
        Type.Boolean({
          description:
            "true ignores case, false matches case; overrides the i flag. When omitted, the i flag ignores case; otherwise smart-case applies to the whole query, whatever other flags are given: any uppercase letter makes it case-sensitive (also when analysis is unavailable).",
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
          description: `Maximum matching lines, across all files (default ${defaultLimit}).`,
        }),
      ),
      outputMode: Type.Optional(
        Type.Union([Type.Literal("content"), Type.Literal("files"), Type.Literal("count")], {
          description:
            '"content" (default): matches/context with anchors for valid UTF-8 or plain previews otherwise; "files": paths; "count": matching lines per file and total. Use files or count when only paths or counts are needed. All modes share limit.',
        }),
      ),
    },
    { additionalProperties: false },
  );
}
type GrepSchema = ReturnType<typeof createGrepSchema>;
/** How grep presents matches; grep-output formats each mode. */
export type GrepOutputMode = NonNullable<Static<GrepSchema>["outputMode"]>;
type GrepTool = ToolDefinition<
  GrepSchema,
  ({ incomplete?: true } & Partial<ReportDetails>) | undefined
>;
/** Validate JavaScript syntax once; the search never rejects a pattern V8 accepts. */
function checkGrepArguments(args: unknown, report: ReportArgumentIssue): void {
  const { pattern, literal, flags } = (args ?? {}) as Record<string, unknown>;
  if (typeof literal !== "boolean" || (flags !== undefined && typeof flags !== "string")) return;
  try {
    buildRegex("", false, flags ?? DEFAULT_GREP_FLAGS);
  } catch (error) {
    report("flags", errorMessage(error));
    return;
  }
  if (literal) return;
  const fields = Array.isArray(pattern)
    ? pattern.map((value, index) => [`pattern[${index}]`, value] as const)
    : [["pattern", pattern] as const];
  for (const [field, value] of fields) {
    if (typeof value !== "string" || value === "") continue;
    try {
      buildRegex(value, true, flags ?? DEFAULT_GREP_FLAGS);
    } catch (error) {
      report(field, errorMessage(error));
    }
  }
}

/** Build the production grep override (a ToolDefinition fragment for registerTool). */
export function makeGrepOverride(
  cwd: string,
  config: HashlineEditConfig,
  budgets: OutputBudgetProvider = defaultOutputBudgets,
) {
  return makeGrepOverrideWithBackend(cwd, config, {}, budgets);
}

/** @internal — build a grep override with deterministic process backends for tests. */
export function makeGrepOverrideWithBackend(
  cwd: string,
  config: HashlineEditConfig,
  overrides: Partial<GrepBackend>,
  budgets: OutputBudgetProvider = defaultOutputBudgets,
) {
  const { hashLen } = config;
  const grepSchema = createGrepSchema(config.grep);
  const backend: GrepBackend = { runRgPaths, runRgLines, ...overrides };

  return {
    name: "grep" as const,
    label: "grep",
    description:
      "Search file contents. Content mode returns LINE#HASH edit anchors for valid UTF-8 and plain line numbers without anchors otherwise; files/count modes return paths or matching-line counts. NUL-containing files are skipped. Directory searches respect ignore rules and skip .git and linked directories. Use grep instead of rg or grep in a shell to search files; use the shell only for ignored, .git, or linked directories, or to filter another command's output.",
    promptSnippet: "Search file contents",
    promptGuidelines: [
      "When you need several independent searches, send them as separate grep calls in one response; they run in parallel.",
      "Copy grep anchors directly into edit.",
    ],
    parameters: grepSchema,
    prepareArguments: createArgumentPreparer("grep", grepSchema, checkGrepArguments, budgets),

    renderShell: "default" as const,

    renderCall(
      args: Static<GrepSchema>,
      theme: Parameters<NonNullable<GrepTool["renderCall"]>>[1],
    ) {
      const rawPattern = args?.pattern;
      const patternText = Array.isArray(rawPattern)
        ? rawPattern.join(" | ")
        : String(rawPattern ?? "");
      const rawPath = args?.path;
      const pathText = Array.isArray(rawPath) ? rawPath.join(" ") : String(rawPath ?? ".");
      let text =
        theme.fg("toolTitle", theme.bold("grep ")) +
        theme.fg("accent", `/${patternText}/${args?.flags ?? ""}`) +
        theme.fg("toolOutput", ` in ${pathText}`);
      if (args?.glob) text += theme.fg("toolOutput", ` (${toArray(args.glob).join(", ")})`);
      if (args?.outputMode && args.outputMode !== "content")
        text += theme.fg("success", ` → ${args.outputMode}`);
      if (args?.limit !== undefined) text += theme.fg("toolOutput", ` limit ${args.limit}`);
      return new Text(text, 0, 0);
    },

    renderResult(
      result: Parameters<NonNullable<GrepTool["renderResult"]>>[0],
      { isPartial, expanded }: Parameters<NonNullable<GrepTool["renderResult"]>>[1],
      theme: Parameters<NonNullable<GrepTool["renderResult"]>>[2],
      context: Parameters<NonNullable<GrepTool["renderResult"]>>[3],
    ) {
      if (isPartial) return new Text(theme.fg("warning", "Searching…"), 0, 0);
      if (context?.isError) return renderToolError(result, theme, expanded);
      const payload = withoutReport(result).content[0];
      const report = result.details?.report;
      return renderOutputPreview(
        [
          ...(payload?.type === "text" ? toDisplayLines(payload.text, theme) : []),
          ...(report ? reportLines(report, theme) : []),
        ],
        expanded,
        theme,
      );
    },

    async execute(
      _toolCallId: string,
      params: Static<GrepSchema>,
      signal: AbortSignal | undefined,
      _onUpdate: Parameters<GrepTool["execute"]>[3],
    ) {
      const budget = budgets();
      return runTool("grep", { path: params.path, signal, budget }, async () => {
        throwIfCancelled(signal);
        const warnings: string[] = [];
        const patterns = toArray(params.pattern);
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
        const { searchPaths, pathInfo } = await resolveSearchPaths(cwd, params.path);
        const unfiltered: SearchScope = {
          globs: toArray(params.glob),
          noIgnore: false,
          follow: false,
          searchPaths,
        };
        const scope: SearchScope = {
          ...unfiltered,
          searchPaths: await filterExplicitFilesByGlob(
            backend,
            bundledRgPath,
            unfiltered,
            pathInfo,
            signal,
            warnings,
          ),
        };
        const search = await searchFiles({
          backend,
          rgPath: bundledRgPath,
          scope,
          query,
          limit: effectiveLimit,
          timeoutMs: config.grep.regexTimeoutMs,
          signal,
          warnings,
        });
        const { payload, facts, incomplete } = await grepOutput({
          cwd,
          search,
          outputMode,
          context: params.context ?? config.grep.defaultContext,
          anchors: createAnchorFormatter(hashLen),
          signal,
          warnings,
          effectiveLimit,
          literalPipe: literal && patterns.some((pattern) => pattern.includes("|")),
          budget,
        });
        return reportResult(
          { tool: "grep" as const, path: params.path, ...facts },
          payload === undefined ? [] : [{ type: "text" as const, text: payload }],
          incomplete ? { incomplete: true as const } : undefined,
        );
      });
    },
  } satisfies GrepTool;
}
