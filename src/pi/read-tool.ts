/**
 * Override read: recognized images and NUL-containing files delegate to Pi's
 * built-in read; valid UTF-8 text outputs "lineNo#hash│content".
 *
 * Hashes are computed from the current content on the fly — nothing is stored.
 * The hash is `(line number, content)`, recomputed and checked at edit time, so
 * no snapshot is needed to verify an anchor later.
 *
 * @module pi-hashline-edit/pi
 */

import {
  createReadToolDefinition,
  detectSupportedImageMimeTypeFromFile,
  getLanguageFromPath,
  highlightCode,
  type ReadToolDetails,
  type ExtensionToolContext,
  type Theme,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { AgentToolUpdateCallback } from "@earendil-works/pi-agent-core";
import { Text } from "@earendil-works/pi-tui";
import { Type, type Static } from "typebox";
import { ephemeralParameter, ephemeralReadDetails } from "./result-retention.ts";
import { EPHEMERAL_TOOL_GUIDELINE } from "./tool-prompts.ts";
import { scanTextLines } from "./text-stream.ts";
import { createAnchorFormatter, displayCarriageReturns, parseHashline } from "./anchor-format.ts";
import { canonicalPath } from "./path.ts";
import { formatEphemeralLabel, renderToolError } from "./render.ts";
import { POSITIVE_SAFE_INTEGER } from "./schema.ts";
import { throwIfCancelled } from "./error-text.ts";
import { formatKiB } from "./budgets.ts";
import type { HashlineEditConfig } from "./config.ts";

const DEFAULT_OFFSET = 1;

type ReadDetails = ReadToolDetails & {
  nativeRead?: true;
} & Partial<ReturnType<typeof ephemeralReadDetails>>;

/** Prefix call metadata before Pi's Text component wraps the native title. */
class ReadCallText extends Text {
  retentionLabel = "";

  override setText(text: string): void {
    super.setText(this.retentionLabel + text);
  }
}

/**
 * First result line: `<path> · <N> lines`, optionally ` (from line <offset>)` and
 * ` · no trailing newline`. A missing final newline is a byte-level fact the
 * numbered rows cannot show, so the header, which the model never copies into an
 * edit `body`, states it. READ_HEADER is the TUI's parser for this exact line.
 */
function formatReadHeader(
  path: string,
  totalLines: number,
  start: number,
  finalNewline: boolean,
): string {
  const shownFrom = start > DEFAULT_OFFSET ? ` (from line ${start})` : "";
  return `${path} · ${totalLines} lines${shownFrom}${finalNewline ? "" : " · no trailing newline"}`;
}
const READ_HEADER = /^(.+?) · (\d+ lines(?: \(from line \d+\))?(?: · no trailing newline)?)$/;

/**
 * Render the expanded read body for the TUI: color the header, strip the
 * `LINE#HASH│` prefix from every anchor line to `   N: content`, and
 * syntax-highlight the code block by the file's language (falls back to a
 * single `toolOutput` color when the language is unknown or the highlight
 * line count diverges). Trailing notices (e.g. truncation) are shown in
 * `warning`.
 */
function renderReadBody(raw: string, path: string, theme: Theme): string {
  const lines = raw.split("\n");
  if (lines.length === 0) return "";
  const out: string[] = [];

  // Header: "<path> · <N> lines", optionally followed by " (from line <offset>)"
  // and/or " · no trailing newline".
  let bodyStart = 0;
  const h = lines[0].match(READ_HEADER);
  if (h) {
    out.push(theme.fg("success", h[1]) + theme.fg("dim", ` · ${h[2]}`));
    bodyStart = 1;
  }

  // Collect anchor rows (full content); the first non-anchor line begins the tail.
  const lineNos: string[] = [];
  const codeContents: string[] = [];
  let tailStart = lines.length;
  for (let i = bodyStart; i < lines.length; i++) {
    const row = parseHashline(lines[i]);
    if (!row) {
      tailStart = i;
      break;
    }
    lineNos.push(row.lineNo);
    codeContents.push(row.content);
  }

  // Syntax-highlight the whole block so multi-line constructs stay correct.
  const detabbed = codeContents.map((l) => l.replace(/\t/g, "   "));
  const lang = getLanguageFromPath(path);
  let rendered: string[];
  if (lang) {
    const hl = highlightCode(detabbed.join("\n"), lang);
    // Guard against highlighters that reshape line count: fall back to plain.
    rendered = hl.length === detabbed.length ? hl : detabbed.map((l) => theme.fg("toolOutput", l));
  } else {
    rendered = detabbed.map((l) => theme.fg("toolOutput", l));
  }
  for (let i = 0; i < rendered.length && i < lineNos.length; i++) {
    out.push(theme.fg("dim", `   ${lineNos[i]}: `) + rendered[i]);
  }

  for (let i = tailStart; i < lines.length; i++) {
    out.push(theme.fg("warning", lines[i]));
  }
  return out.join("\n");
}

/** Build the read override (a ToolDefinition fragment for registerTool). */
export function makeReadOverride(cwd: string, config: HashlineEditConfig) {
  const { hashLen } = config;
  const { defaultLimit } = config.read;
  const maxBytes = config.read.maxKiB * 1024;
  const builtin = createReadToolDefinition(cwd);
  const parameters = Type.Object(
    {
      ...builtin.parameters.properties,
      path: Type.String({ ...builtin.parameters.properties.path, minLength: 1 }),
      offset: Type.Optional(
        Type.Number({
          ...POSITIVE_SAFE_INTEGER,
          description: `1-based line to start from (default ${DEFAULT_OFFSET}).`,
        }),
      ),
      limit: Type.Optional(
        Type.Number({
          ...POSITIVE_SAFE_INTEGER,
          description: `Maximum lines to read (default ${defaultLimit}).`,
        }),
      ),
      ephemeral: ephemeralParameter,
    },
    { additionalProperties: false },
  );

  return {
    name: "read" as const,
    label: "read",
    description:
      "Read a file. Text lines show as LINE#HASH│content anchors for edit; CRLF line endings show as LF.",
    promptSnippet: "Read files with editable line anchors",
    promptGuidelines: [
      "Prefer read over shell output for files you intend to edit.",
      "For large files, pass read offset and limit to read only the relevant section.",
      EPHEMERAL_TOOL_GUIDELINE,
    ],
    parameters,
    renderShell: "default" as const,

    renderCall(args, theme, context) {
      const call =
        context.lastComponent instanceof ReadCallText
          ? context.lastComponent
          : new ReadCallText("", 0, 0);
      call.retentionLabel = formatEphemeralLabel(args?.ephemeral, theme);
      return builtin.renderCall!(args, theme, { ...context, lastComponent: call });
    },

    renderResult(result, options, theme, context) {
      const { isPartial, expanded } = options;
      if (isPartial) return new Text(theme.fg("warning", "Reading…"), 0, 0);
      const content = result.content?.[0];
      if (context?.isError) return renderToolError(result, theme, expanded);
      if (result.details?.nativeRead) return builtin.renderResult!(result, options, theme, context);
      // Collapsed (not expanded): show nothing — the call line carries the
      // title, matching the built-in read's fold behavior.
      if (!expanded) return new Text("", 0, 0);
      const raw = content?.type === "text" ? content.text : "";
      return new Text(renderReadBody(raw, String(context?.args?.path ?? ""), theme), 0, 0);
    },

    async execute(
      toolCallId: string,
      params: Static<typeof parameters>,
      signal: AbortSignal | undefined,
      onUpdate: AgentToolUpdateCallback<ReadToolDetails | undefined> | undefined,
      ctx: ExtensionToolContext,
    ) {
      throwIfCancelled(signal);
      const offset = params.offset ?? DEFAULT_OFFSET;
      const limit = params.limit ?? defaultLimit;
      const retention = params.ephemeral
        ? ephemeralReadDetails(params.path, offset, limit)
        : undefined;
      const anchors = createAnchorFormatter(hashLen);
      const readNative = async () => {
        const result = await builtin.execute(toolCallId, params, signal, onUpdate, ctx);
        return {
          ...result,
          details: { ...result.details, ...retention, nativeRead: true as const },
        };
      };

      const absPath = canonicalPath(cwd, params.path as string);
      try {
        if (await detectSupportedImageMimeTypeFromFile(absPath)) {
          return readNative();
        }
      } catch {
        return readNative();
      }

      const start = offset;
      const rows: string[] = [];
      const crExpansion = Buffer.byteLength(displayCarriageReturns("\r")) - 1;
      let totalRows = 0;
      let totalBytes = 0;
      let outputBytes = 0;
      let truncated = false;
      let firstLineExceedsLimit = false;
      let stats: Awaited<ReturnType<typeof scanTextLines>>;
      try {
        stats = await scanTextLines(
          absPath,
          (number) => number >= start && number - start < limit,
          (line) => {
            const rowBytes =
              line.byteLength +
              line.carriageReturns * crExpansion +
              Buffer.byteLength(anchors.row(line.number, ""));
            totalBytes += rowBytes + (totalRows++ > 0 ? 1 : 0);
            if (truncated) return;
            const nextBytes = outputBytes + rowBytes + (rows.length > 0 ? 1 : 0);
            if (nextBytes > maxBytes) {
              truncated = true;
              firstLineExceedsLimit = rows.length === 0;
              return;
            }
            rows.push(anchors.row(line.number, line.text!));
            outputBytes = nextBytes;
          },
          { signal, maxLineBytes: maxBytes },
        );
      } catch (error) {
        // Keep native filesystem diagnostics without retrying decoding or cancellation failures.
        if (!signal?.aborted && error instanceof Error && "code" in error) {
          return readNative();
        }
        throw error;
      }
      if (stats.hasNul) return readNative();
      const pagination =
        !truncated && rows.length > 0 && stats.totalLines - start >= limit
          ? {
              start,
              end: start + (rows.length - 1),
              totalLines: stats.totalLines,
              nextOffset: start + rows.length,
            }
          : undefined;
      const truncation = {
        content: rows.join("\n"),
        truncated,
        truncatedBy: truncated ? ("bytes" as const) : null,
        totalLines: totalRows,
        totalBytes,
        outputLines: rows.length,
        outputBytes,
        lastLinePartial: false,
        firstLineExceedsLimit,
        maxLines: totalRows,
        maxBytes,
      };

      const tail = truncation.firstLineExceedsLimit
        ? `\n… (line ${start} exceeds ${formatKiB(maxBytes)}; cannot return a complete anchor row. Reducing limit cannot split a physical line; use bash to inspect it in chunks, or replace for a known literal/regex change)`
        : truncation.truncated
          ? `\n… (truncated at ${formatKiB(maxBytes)}; use offset/limit to read more)`
          : pagination
            ? `\n… (showing lines ${pagination.start}-${pagination.end} of ${pagination.totalLines}; use offset ${pagination.nextOffset} to continue)`
            : "";
      const header = `${formatReadHeader(params.path, stats.totalLines, start, stats.finalNewline)}\n`;
      const body = truncation.content;

      return {
        content: [{ type: "text" as const, text: header + body + tail }],
        details: retention
          ? {
              ...(truncation.truncated ? { truncation } : pagination ? { pagination } : {}),
              ...retention,
            }
          : truncation.truncated
            ? { truncation }
            : pagination
              ? { pagination }
              : undefined,
      };
    },
  } satisfies ToolDefinition<typeof parameters, ReadDetails | undefined>;
}
