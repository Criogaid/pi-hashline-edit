/**
 * Override grep: valid UTF-8 results feed edit; malformed UTF-8 uses non-editable previews.
 * Scope and paths live in grep-scope; JavaScript regex translation in rg-regex;
 * search requests and ripgrep events in grep-search; the rg process layer in
 * rg-process; result formatting in
 * grep-output; TUI presentation in grep-render. This module owns the tool
 * schema, the production backend, render wiring, and execution order.
 * @module pi-hashline-edit/pi
 */

import { type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { rgPath as bundledRgPath } from "@vscode/ripgrep";
import { Type, type Static } from "typebox";
import { Text } from "@earendil-works/pi-tui";
import { renderOutputPreview, renderToolError, reportLines, withoutReport } from "./render.ts";
import { type ForgetReceiptDetails, grepReceipt, withResultTag } from "./forget-tool.ts";
import { createAnchorFormatter } from "./anchor-format.ts";
import { assembleGrepOutput, formatMatches, searchIncompleteError } from "./grep-output.ts";
import {
  assertValidRegex,
  filterExplicitFilesByGlob,
  toArray,
  resolveSearchPaths,
} from "./grep-scope.ts";
import {
  runRgSearch,
  searchMatches,
  type GrepBackend,
  type SearchScope,
  type SearchFileSnapshot,
} from "./grep-search.ts";
export type { GrepBackend } from "./grep-search.ts";
import { toDisplayLines } from "./grep-render.ts";
import { probeRegex, runRgPaths } from "./rg-process.ts";
import { RegexTranslationError, smartIgnoreCase, translateQuery } from "./rg-regex.ts";
import { buildRegex } from "../core/replace.ts";
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
            "String or array of strings; an array matches any of them, so use it for alternatives instead of joining them with |. Regex syntax is JavaScript, as in replace; ^ and $ match at line boundaries. Use explicit character classes: . and classes that can split a UTF-16 surrogate pair are rejected.",
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
      ignoreCase: Type.Optional(
        Type.Boolean({
          description:
            "true ignores case, false matches case; omitted uses smart-case for the whole query.",
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
type GrepTool = ToolDefinition<
  GrepSchema,
  ({ incomplete?: true } & ForgetReceiptDetails & Partial<ReportDetails>) | undefined
>;
/** Report patterns JavaScript or ripgrep cannot compile; Pi checks field shapes. */
function checkGrepArguments(args: unknown, report: ReportArgumentIssue): void {
  const {
    pattern,
    literal,
    multiline = false,
    ignoreCase,
  } = (args ?? {}) as Record<string, unknown>;
  if (typeof literal !== "boolean" || typeof multiline !== "boolean") return;
  const fields = Array.isArray(pattern)
    ? pattern.map((value, index) => [`pattern[${index}]`, value] as const)
    : [["pattern", pattern] as const];
  const valid = fields.filter(([field, value]) => {
    if (typeof value !== "string" || value === "") return false;
    if (literal) return true;
    try {
      buildRegex(value, true, undefined);
      return true;
    } catch (error) {
      report(field, errorMessage(error));
      return false;
    }
  }) as (readonly [string, string])[];
  // Case affects translation, so check with the case the search will use.
  const caseless =
    typeof ignoreCase === "boolean"
      ? ignoreCase
      : smartIgnoreCase(
          valid.map(([, value]) => value),
          literal,
        );
  for (const [field, value] of valid) {
    try {
      translateQuery({ patterns: [value], literal, ignoreCase: caseless, multiline });
    } catch (error) {
      report(
        field,
        errorMessage(error),
        error instanceof RegexTranslationError ? error.fix : undefined,
      );
    }
  }
}

/** The grep card shows the forget id only on the forget card. */
const GREP_CARD_SHOWN = new Set(["resultId"]);

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
  const backend: GrepBackend = {
    search: runRgSearch,
    runRgPaths,
    probeRegex,
    ...overrides,
  };

  return {
    name: "grep" as const,
    label: "grep",
    description:
      "Search file contents with ripgrep. Content mode returns LINE#HASH edit anchors for valid UTF-8 and plain line numbers without anchors otherwise; files/count modes return paths or matching-line counts. NUL-containing files are skipped. Directory searches respect ignore rules and skip linked directories. Use grep instead of rg or grep in a shell to search files; use the shell only for ignored or linked directories, or to filter another command's output.",
    promptSnippet: "Search file contents with ripgrep",
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
        theme.fg("accent", `/${patternText}/`) +
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
          ...(report ? reportLines(report, theme, expanded, GREP_CARD_SHOWN) : []),
        ],
        expanded,
        theme,
      );
    },

    async execute(
      toolCallId: string,
      params: Static<GrepSchema>,
      signal: AbortSignal | undefined,
      _onUpdate: Parameters<GrepTool["execute"]>[3],
    ) {
      const budget = budgets();
      return runTool("grep", { path: params.path, signal, budget }, async () => {
        throwIfCancelled(signal);
        const anchors = createAnchorFormatter(hashLen);
        const warnings: string[] = [];

        const patterns = toArray(params.pattern);
        const effectiveLimit = params.limit ?? config.grep.defaultLimit;
        const context = params.context ?? config.grep.defaultContext;
        const rgPath = bundledRgPath;
        const outputMode: "content" | "files" | "count" = params.outputMode ?? "content";
        const multiline = params.multiline ?? false;
        const globs = toArray(params.glob);
        const { literal } = params;
        const ignoreCase = params.ignoreCase ?? smartIgnoreCase(patterns, literal);
        const matchers = translateQuery({ patterns, literal, ignoreCase, multiline });
        // Escaped literal text always compiles; only regex syntax needs ripgrep's check.
        if (!literal) await assertValidRegex(matchers, rgPath, backend, signal);
        const ctx = context;
        const { searchPaths, pathInfo } = await resolveSearchPaths(cwd, params.path);
        let scope: SearchScope = {
          globs,
          noIgnore: false,
          follow: false,
          searchPaths,
        };

        scope = {
          ...scope,
          searchPaths: await filterExplicitFilesByGlob(
            backend,
            rgPath,
            scope,
            pathInfo,
            signal,
            warnings,
          ),
        };

        const result =
          scope.searchPaths.length === 0
            ? {
                raw: [],
                matchLimitReached: false,
                snapshots: new Map<string, SearchFileSnapshot>(),
              }
            : await searchMatches({
                backend,
                rgPath,
                scope,
                matchers,
                limit: effectiveLimit,
                signal,
                warnings,
              });
        const { raw, matchLimitReached } = result;

        const report = { tool: "grep", path: params.path };
        if (raw.length === 0) {
          if (warnings.length)
            throw searchIncompleteError("No matches confirmed.", warnings, budget);
          return reportResult({ ...report, matches: 0, files: 0 });
        }

        const formatted = await formatMatches({
          cwd,
          raw,
          outputMode,
          context: ctx,
          anchors,
          signal,
          warnings,
          searchSnapshots: result.snapshots,
          budget,
        });
        const { payload, facts } = assembleGrepOutput({
          formatted,
          warnings,
          outputMode,
          matchLimitReached,
          effectiveLimit,
          budget,
        });
        const parts = {
          report: { ...report, ...facts },
          payload: [{ type: "text" as const, text: payload }],
          details: warnings.length ? { incomplete: true as const } : undefined,
        };
        // Only content mode returns file text; paths and counts have nothing to forget.
        if (outputMode !== "content")
          return reportResult(parts.report, parts.payload, parts.details);
        return withResultTag(toolCallId, parts, config.forget, () =>
          grepReceipt(patterns, formatted.matches, formatted.files, {
            limitReached: matchLimitReached,
            incomplete: warnings.length > 0,
          }),
        );
      });
    },
  } satisfies GrepTool;
}
