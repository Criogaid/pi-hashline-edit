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
import { assembleGrepOutput, formatMatches, formatSearchWarnings } from "./grep-output.ts";
import {
  filterExplicitFilesByGlob,
  literalFallbackNotice as formatLiteralFallbackNotice,
  REGEX_SYNTAX,
  resolveLiteralMode,
  toArray,
  resolveSearchPaths,
} from "./grep-scope.ts";
import { searchMatches, type GrepBackend, type SearchScope } from "./grep-search.ts";
export type { GrepBackend } from "./grep-search.ts";
import { toDisplayLines } from "./grep-render.ts";
import { resolveIgnoreCase, runRg, runRgPaths, type SearchModes } from "./rg-line-filter.ts";
import { runRgTextView } from "./rg-text-view.ts";
import { integerRange, POSITIVE_SAFE_INTEGER } from "./schema.ts";
import { throwIfCancelled } from "./error-text.ts";
import { getState } from "./state.ts";

const DEFAULT_LIMIT = 100;
const GREP_CONTEXT_MAX = 20;

const grepOverrideSchema = Type.Object(
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
        [Type.String({ minLength: 1 }), Type.Array(Type.String({ minLength: 1 }), { minItems: 1 })],
        {
          description:
            "Existing file or directory, or an array of them; omit to search the working directory. Wildcards are not expanded; use glob.",
        },
      ),
    ),
    glob: Type.Optional(
      Type.Union(
        [Type.String({ minLength: 1 }), Type.Array(Type.String({ minLength: 1 }), { minItems: 1 })],
        {
          description:
            "Filename glob, or an ordered array of them; prefix exclusions with !, e.g. ['*.ts', '!**/*.test.ts'].",
        },
      ),
    ),
    literal: Type.Optional(
      Type.Boolean({
        description:
          "true: match the text literally. false: ripgrep Rust regex. Omitted: regex when the pattern has metacharacters; a single invalid pattern falls back to a literal search of the whole string, an invalid array fails.",
      }),
    ),
    ignoreCase: Type.Optional(
      Type.Boolean({
        description:
          "true ignores case, false matches case; omitted uses smart-case for the whole query. Inline regex flags still apply.",
      }),
    ),
    multiline: Type.Optional(
      Type.Boolean({
        description:
          "Match across lines (default false); every line a match touches is anchored. The . wildcard does not match newlines; use \\n or (?s).",
      }),
    ),
    context: Type.Optional(
      Type.Number({
        ...integerRange(0, GREP_CONTEXT_MAX),
        description: `Anchored lines shown before and after each match (0-${GREP_CONTEXT_MAX}, default 0); display only, not matched.`,
      }),
    ),
    limit: Type.Optional(
      Type.Number({
        ...POSITIVE_SAFE_INTEGER,
        description: "Maximum matching lines, across all files (default 100).",
      }),
    ),
    outputMode: Type.Optional(
      Type.Union([Type.Literal("content"), Type.Literal("files"), Type.Literal("count")], {
        description:
          '"content" (default): anchored lines; "files": paths; "count": matching lines per file and total. All modes share limit.',
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
      "Search file contents with ripgrep. Content mode returns LINE#HASH anchors usable by edit; files/count modes return paths or matching-line counts. CRLF is searched as LF. Directory searches respect ignore rules and skip linked directories.",
    promptSnippet: "Search file contents with ripgrep",
    promptGuidelines: [
      "Prefer grep for file-content searches; use another tool for ignored or linked directories.",
      'In grep, omit path to search the working directory (never pass ""); use glob for filename wildcards.',
      "In grep, set literal:true for code with regex punctuation; grep regex is ripgrep (Rust) syntax without lookaround or backreferences.",
      "In grep, use a pattern array for alternatives instead of joining them with |, and context:3-5 when searching code to edit.",
      "In grep, use multiline:true for cross-line matches and outputMode files or count when only paths or counts are needed.",
      "Copy grep anchors directly into edit; read the full line before rewriting from a partial preview.",
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
      throwIfCancelled(signal);
      const anchors = createAnchorFormatter(getState().config.hashLen);
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
      const literalFallbackNotice = literalFallback
        ? formatLiteralFallbackNotice(patterns)
        : undefined;
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
                "No matches found" +
                (literalFallbackNotice ? `\n\n[${literalFallbackNotice}]` : ""),
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
        literalFallbackNotice,
        matchLimitReached,
        effectiveLimit,
        linesTruncated,
      });
    },
  } satisfies GrepTool;
}
