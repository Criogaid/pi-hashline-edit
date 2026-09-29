/**
 * Override grep: anchored `LINE#HASH│` results feed edit without a re-read.
 * Scope and paths live in grep-scope; ripgrep events in grep-search; output and
 * byte budgets in grep-output; TUI presentation in grep-render. This module
 * owns the tool schema, render wiring, and execution order.
 * @module pi-hashline-edit/pi
 */

import { type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { rgPath as bundledRgPath } from "@vscode/ripgrep";
import { Type, type Static } from "typebox";
import { Text } from "@earendil-works/pi-tui";
import { normalizeLineEndings } from "../core/lines.ts";
import { createAnchorFormatter } from "./anchor-format.ts";
import { renderToolError } from "./render.ts";
import {
  assembleGrepOutput,
  formatMatches,
  formatSearchWarnings,
  LITERAL_FALLBACK_NOTICE,
} from "./grep-output.ts";
import {
  filterExplicitFilesByGlob,
  REGEX_SYNTAX,
  resolveLiteralMode,
  toArray,
  resolveSearchPaths,
} from "./grep-scope.ts";
import { searchMatches, type GrepBackend, type SearchScope } from "./grep-search.ts";
export type { GrepBackend } from "./grep-search.ts";
import { integerRange, POSITIVE_SAFE_INTEGER } from "./schema.ts";
import { toDisplayLines } from "./grep-render.ts";
import { resolveIgnoreCase, runRg, runRgPaths, type SearchModes } from "./rg-line-filter.ts";
import { runRgTextView } from "./rg-text-view.ts";
import { parseToolInput } from "./tool-input.ts";

const DEFAULT_LIMIT = 100;
const GREP_CONTEXT_MAX = 20;

const grepOverrideSchema = Type.Object(
  {
    pattern: Type.Union(
      [Type.String({ minLength: 1 }), Type.Array(Type.String({ minLength: 1 }), { minItems: 1 })],
      {
        description:
          "Non-empty string or array of non-empty strings (OR across patterns; whitespace-only strings are valid). For code snippets with regex punctuation, set literal:true; use an array for alternatives instead of joining literals with |.",
      },
    ),
    path: Type.Optional(
      Type.Union(
        [Type.String({ minLength: 1 }), Type.Array(Type.String({ minLength: 1 }), { minItems: 1 })],
        {
          description:
            "Omit path to search the working directory. When supplied, use a non-empty existing file or directory, or a non-empty array of them; empty strings and arrays are invalid. Path wildcards are not expanded; use glob to filter filenames.",
        },
      ),
    ),
    glob: Type.Optional(
      Type.Union(
        [Type.String({ minLength: 1 }), Type.Array(Type.String({ minLength: 1 }), { minItems: 1 })],
        {
          description:
            "Filter filenames with a wildcard glob pattern; pass an array for multiple filters and prefix exclusions with `!`, e.g. ['*.ts', '!**/*.test.ts']",
        },
      ),
    ),
    literal: Type.Optional(
      Type.Boolean({
        description:
          "Set true for literal code text, especially calls, brackets, pipes, and backslashes. Set false only for intentional ripgrep Rust regex. Automatic mode tries regex for metacharacters; one invalid pattern can fall back to searching the entire input literally, but invalid pattern arrays fail. Literal mode uses the same case setting as regex mode.",
      }),
    ),
    ignoreCase: Type.Optional(
      Type.Boolean({
        description:
          "Override query-level smart-case: true ignores case; false distinguishes case. Inline regex case flags can still override either setting. Omit for smart-case across the whole query.",
      }),
    ),
    multiline: Type.Optional(
      Type.Boolean({
        description:
          "Allow matches across physical lines (default: false). CRLF is searched as LF; results anchor each distinct physical line touched by a match. Context only changes displayed lines.",
      }),
    ),
    context: Type.Optional(
      Type.Number({
        ...integerRange(0, GREP_CONTEXT_MAX),
        description: `Integer number of lines to show before and after each match (0-${GREP_CONTEXT_MAX}; default: 0). Set to 3-5 when searching code to edit so surrounding lines and anchors are included without needing a separate read; context lines are anchored too`,
      }),
    ),
    limit: Type.Optional(
      Type.Number({
        ...POSITIVE_SAFE_INTEGER,
        description: "Positive integer maximum of matching lines to return (default: 100)",
      }),
    ),
    outputMode: Type.Optional(
      Type.Union([Type.Literal("content"), Type.Literal("files"), Type.Literal("count")], {
        description:
          '"content" (default): anchored lines. "files": paths. "count": matching lines per file and total. All modes share the limit on matching lines.',
      }),
    ),
  },
  { additionalProperties: false },
);
type GrepTool = ToolDefinition<typeof grepOverrideSchema, { incomplete?: true } | undefined>;

/** Build the production grep override (a ToolDefinition fragment for registerTool). */
export function makeGrepOverride(cwd: string) {
  return makeGrepOverrideWithBackend(cwd, {});
}

/** @internal — build a grep override with deterministic process backends for tests. */
export function makeGrepOverrideWithBackend(cwd: string, overrides: Partial<GrepBackend>) {
  const backend: GrepBackend = {
    runRg: runRgTextView,
    runRgPaths,
    resolveIgnoreCase,
    ...overrides,
  };

  return {
    name: "grep" as const,
    label: "grep",
    description:
      "Search LF-normalized file contents with ripgrep. Content mode returns LINE#HASH anchors for logical lines; files/count modes return paths or limited matching-line counts. CRLF queries normalize to LF; standalone CR stays content. Pattern arrays use OR; smart-case applies unless ignoreCase overrides it. Set multiline:true to match across lines; context only changes display. Directory searches respect ignore rules and skip linked directories.",
    promptSnippet: "Search file contents with ripgrep",
    promptGuidelines: [
      "Prefer grep for file-content searches.",
      "Omit path for the working directory; never pass an empty path. Use glob for filename wildcards.",
      "Use literal:true for code containing regex punctuation; use literal:false only for intentional regex.",
      "Use a pattern array for OR alternatives.",
      "Copy grep anchors directly into edit; inspect the full line before rewriting from a partial preview.",
      "Use context:3-5 when searching code to edit so surrounding lines are anchored.",
      "Use files/count when only paths or counts are needed.",
      "Use multiline:true for cross-line matches.",
      "Use another tool to traverse ignored or linked directories.",
    ],
    parameters: grepOverrideSchema,

    renderShell: "default" as const,

    renderCall(
      args: Static<typeof grepOverrideSchema>,
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
      if (context?.isError) return renderToolError(result, theme);
      const out = result.content?.[0]?.type === "text" ? result.content[0].text : "";
      const styled = toDisplayLines(out, theme);
      const maxLines = expanded ? styled.length : 15;
      const shown = styled.slice(0, maxLines);
      const more =
        !expanded && styled.length > maxLines
          ? `\n${theme.fg("muted", `… (${styled.length - maxLines} more lines)`)}`
          : "";
      return new Text(shown.join("\n") + more, 0, 0);
    },

    async execute(
      _toolCallId: string,
      params: Static<typeof grepOverrideSchema>,
      signal: AbortSignal | undefined,
      _onUpdate: Parameters<GrepTool["execute"]>[3],
    ) {
      if (signal?.aborted) throw new Error("Operation aborted");
      params = parseToolInput("grep", grepOverrideSchema, params);
      const anchors = createAnchorFormatter();
      const warnings: string[] = [];

      const patterns = toArray(params.pattern).map(normalizeLineEndings);
      const effectiveLimit = params.limit ?? DEFAULT_LIMIT;
      const context = params.context ?? 0;
      const rgPath = bundledRgPath;
      const outputMode: "content" | "files" | "count" = params.outputMode ?? "content";
      const multiline = params.multiline ?? false;
      const globs = toArray(params.glob);
      const literal = await resolveLiteralMode(
        patterns,
        params.literal,
        multiline,
        rgPath,
        backend,
        signal,
        patterns.length === 1,
      );
      const literalFallback =
        params.literal === undefined &&
        literal &&
        patterns.some((pattern) => REGEX_SYNTAX.test(pattern));
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
          ? { raw: [], matchLimitReached: false, revisions: new Map<string, string>() }
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
          content: [
            {
              type: "text" as const,
              text:
                "No matches found" + (literalFallback ? `\n\n[${LITERAL_FALLBACK_NOTICE}]` : ""),
            },
          ],
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
        searchRevisions: result.revisions,
      });
      return assembleGrepOutput({
        blocks,
        warnings,
        outputMode,
        literalFallback,
        matchLimitReached,
        effectiveLimit,
        linesTruncated,
      });
    },
  } satisfies GrepTool;
}
