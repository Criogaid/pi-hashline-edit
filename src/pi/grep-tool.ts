/**
 * Override grep: valid UTF-8 results feed edit; malformed UTF-8 uses non-editable previews.
 * Scope and paths live in grep-scope; search requests and ripgrep events in
 * grep-search; the rg process layer in rg-process; result formatting in
 * grep-output; TUI presentation in grep-render. This module owns the tool
 * schema, the production backend, render wiring, and execution order.
 * @module pi-hashline-edit/pi
 */

import { type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { rgPath as bundledRgPath } from "@vscode/ripgrep";
import { Type, type Static } from "typebox";
import { Text } from "@earendil-works/pi-tui";
import { renderOutputPreview, renderToolError } from "./render.ts";
import { withResultTag } from "./forget-tool.ts";
import { normalizeLineEndings } from "../core/lines.ts";
import { createAnchorFormatter } from "./anchor-format.ts";
import { assembleGrepOutput, formatMatches, formatSearchWarnings } from "./grep-output.ts";
import {
  assertValidRegex,
  filterExplicitFilesByGlob,
  toArray,
  resolveSearchPaths,
} from "./grep-scope.ts";
import {
  searchMatches,
  type GrepBackend,
  type SearchScope,
  type SearchFileSnapshot,
} from "./grep-search.ts";
export type { GrepBackend } from "./grep-search.ts";
import { toDisplayLines } from "./grep-render.ts";
import { probeRegex, resolveIgnoreCase, runRgPaths, type SearchModes } from "./rg-process.ts";
import { runRgTextView } from "./rg-text-view.ts";
import { GREP_CONTEXT_RANGE, POSITIVE_SAFE_INTEGER } from "./schema.ts";
import { throwIfCancelled } from "./error-text.ts";
import type { HashlineEditConfig } from "./config.ts";
import { createArgumentPreparer } from "./argument-validation.ts";

/** Grep parameters; descriptions state the configured defaults. */
function createGrepSchema({ defaultLimit, defaultContext }: HashlineEditConfig["grep"]) {
  return Type.Object(
    {
      pattern: Type.Union(
        [Type.String({ minLength: 1 }), Type.Array(Type.String({ minLength: 1 }), { minItems: 1 })],
        {
          description:
            "String or array of strings (an array matches any of them). Regex syntax is ripgrep's Rust regex, not JavaScript: no lookaround or backreferences; ^ and $ match at line boundaries.",
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
              "Filename glob, or an ordered array of them; prefix exclusions with !, e.g. ['*.ts', '!**/*.test.ts'].",
          },
        ),
      ),
      literal: Type.Boolean({
        description:
          "true: match the text exactly, including regex punctuation. false: ripgrep Rust regex, where foo(0) matches foo0.",
      }),
      ignoreCase: Type.Optional(
        Type.Boolean({
          description:
            "true ignores case, false matches case; omitted uses smart-case for the whole query. Inline regex flags still apply.",
        }),
      ),
      multiline: Type.Optional(
        Type.Boolean({
          description:
            "Match across lines (default false); content mode returns every line a match touches. The . wildcard does not match newlines; use \\n or (?s).",
        }),
      ),
      context: Type.Optional(
        Type.Number({
          ...GREP_CONTEXT_RANGE,
          description: `Lines shown before and after each match (${GREP_CONTEXT_RANGE.minimum}-${GREP_CONTEXT_RANGE.maximum}, default ${defaultContext}); display only, not matched.`,
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
            '"content" (default): matches/context with anchors for valid UTF-8 or plain previews otherwise; "files": paths; "count": matching lines per file and total. All modes share limit.',
        }),
      ),
    },
    { additionalProperties: false },
  );
}
type GrepSchema = ReturnType<typeof createGrepSchema>;
type GrepTool = ToolDefinition<GrepSchema, { incomplete?: true } | undefined>;

/** Build the production grep override (a ToolDefinition fragment for registerTool). */
export function makeGrepOverride(cwd: string, config: HashlineEditConfig) {
  return makeGrepOverrideWithBackend(cwd, config, {});
}

/** @internal — build a grep override with deterministic process backends for tests. */
export function makeGrepOverrideWithBackend(
  cwd: string,
  config: HashlineEditConfig,
  overrides: Partial<GrepBackend>,
) {
  const { hashLen } = config;
  const grepSchema = createGrepSchema(config.grep);
  const backend: GrepBackend = {
    search: runRgTextView,
    runRgPaths,
    resolveIgnoreCase,
    probeRegex,
    ...overrides,
  };

  return {
    name: "grep" as const,
    label: "grep",
    description:
      "Search file contents with ripgrep. Content mode returns LINE#HASH edit anchors for valid UTF-8 and plain line numbers without anchors otherwise; files/count modes return paths or matching-line counts. Valid UTF-8 CRLF is searched as LF; invalid UTF-8 is searched as raw bytes. NUL-containing files are skipped. Directory searches respect ignore rules and skip linked directories.",
    promptSnippet: "Search file contents with ripgrep",
    promptGuidelines: [
      "Prefer grep for file-content searches; use another tool for ignored or linked directories.",
      "In grep, use glob for filename wildcards.",
      "In grep, use literal:true for exact text, including names, paths, and code snippets; use literal:false only for intentional regex.",
      "In grep, use a pattern array for alternatives instead of joining them with |, and context:3-5 when searching code to edit.",
      "In grep, use multiline:true for cross-line matches and outputMode files or count when only paths or counts are needed.",
      "Copy grep anchors directly into edit; read the full line before rewriting from a partial preview.",
    ],
    parameters: grepSchema,
    prepareArguments: createArgumentPreparer("grep", grepSchema),

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
      const out = result.content?.[0]?.type === "text" ? result.content[0].text : "";
      return renderOutputPreview(toDisplayLines(out, theme), expanded, theme);
    },

    async execute(
      toolCallId: string,
      params: Static<GrepSchema>,
      signal: AbortSignal | undefined,
      _onUpdate: Parameters<GrepTool["execute"]>[3],
    ) {
      throwIfCancelled(signal);
      const anchors = createAnchorFormatter(hashLen);
      const warnings: string[] = [];

      const patterns = toArray(params.pattern).map(normalizeLineEndings);
      const effectiveLimit = params.limit ?? config.grep.defaultLimit;
      const context = params.context ?? config.grep.defaultContext;
      const rgPath = bundledRgPath;
      const outputMode: "content" | "files" | "count" = params.outputMode ?? "content";
      const multiline = params.multiline ?? false;
      const globs = toArray(params.glob);
      const { literal } = params;
      if (!literal) await assertValidRegex(patterns, multiline, rgPath, backend, signal);
      const matcherIgnoreCase = await backend.resolveIgnoreCase(
        rgPath,
        patterns,
        { literal, multiline },
        params.ignoreCase,
        signal,
      );
      const modes: SearchModes = { literal, ignoreCase: matcherIgnoreCase, multiline };
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
          ? { raw: [], matchLimitReached: false, snapshots: new Map<string, SearchFileSnapshot>() }
          : await searchMatches({
              backend,
              rgPath,
              scope,
              patterns,
              modes,
              limit: effectiveLimit,
              outputMode,
              signal,
              warnings,
            });
      const { raw, matchLimitReached } = result;

      if (raw.length === 0) {
        if (warnings.length)
          throw new Error(`No matches confirmed.${formatSearchWarnings(warnings)}`);
        return {
          content: [{ type: "text" as const, text: "No matches found" }],
          details: undefined,
        };
      }

      const { blocks, linesTruncated } = await formatMatches({
        cwd,
        raw,
        outputMode,
        context: ctx,
        anchors,
        signal,
        warnings,
        searchSnapshots: result.snapshots,
      });
      const output = assembleGrepOutput({
        blocks,
        warnings,
        outputMode,
        matchLimitReached,
        effectiveLimit,
        linesTruncated,
      });
      // Only content mode returns file text; paths and counts have nothing to forget.
      return outputMode === "content" ? withResultTag(toolCallId, output, config.forget) : output;
    },
  } satisfies GrepTool;
}
