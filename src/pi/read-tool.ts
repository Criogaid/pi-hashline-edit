/**
 * Override read: recognized images and NUL-containing files delegate to Pi's
 * built-in read; valid UTF-8 text outputs "lineNo#hash│content", or the lines alone
 * when the caller sets `anchors: false` for a file it will not edit.
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
  type ReadToolInput,
  type ReadToolDetails,
  type ExtensionToolContext,
  type Theme,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { AgentToolUpdateCallback } from "@earendil-works/pi-agent-core";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { scanTextLines } from "./text-stream.ts";
import { createAnchorFormatter, displayCarriageReturns, parseHashline } from "./anchor-format.ts";
import { canonicalPath, serializePath } from "./path.ts";
import { renderToolError, reportLines, splitReport } from "./render.ts";
import { POSITIVE_SAFE_INTEGER, STRICT_SAMPLING } from "./schema.ts";
import { errnoCode } from "../core/errors.ts";
import { throwIfCancelled } from "./error-text.ts";
import { reportResult, runTool, type ReportDetails } from "./report.ts";
import { formatByteSize } from "./budgets.ts";
import type { ToolEnvironment } from "./config.ts";
import { createArgumentPreparer } from "./argument-validation.ts";

const DEFAULT_OFFSET = 1;

/** Pi's read details for a delegated native read; the report states this read's own facts. */
type ReadDetails = (ReadToolDetails & { nativeRead?: true }) & Partial<ReportDetails>;

/** Pi's read arguments plus this override's own. */
type ReadInput = ReadToolInput & { anchors?: boolean };

/**
 * First result line: `<path> · <N> lines`, optionally ` (from line <offset>)` and
 * ` · no trailing newline`. A missing final newline is a byte-level fact the
 * numbered rows cannot show, so the header, which the model never copies into an
 * edit `lines`, states it. READ_HEADER is the TUI's parser for this exact line.
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
const READ_HEADER = /^(.+?) · (\d+ lines(?: \(from line \d+\))?(?: · no trailing newline)?)$/s;

/**
 * Render the expanded read body for the TUI: color the header, strip the
 * `LINE#HASH│` prefix from every anchor line to `   N: content` (rows read with
 * `anchors: false` have no prefix and are numbered from the header's offset), and
 * syntax-highlight the code block by the file's language (falls back to a
 * single `toolOutput` color when the language is unknown or the highlight
 * line count diverges). Notices are report facts, rendered from the report.
 */
function renderReadBody(
  raw: string,
  path: string,
  anchored: boolean,
  lineTooLong: boolean,
  theme: Theme,
): string {
  const lines = raw.split("\n");
  const out: string[] = [];

  // Header: "<path> · <N> lines", optionally followed by " (from line <offset>)"
  // and/or " · no trailing newline".
  let bodyStart = 0;
  const h = lines[0].match(READ_HEADER);
  if (h) {
    out.push(theme.fg("success", h[1]) + theme.fg("dim", ` · ${h[2]}`));
    bodyStart = 1;
  }

  // Collect rows (full content).
  const lineNos: string[] = [];
  const codeContents: string[] = [];
  const firstLine = Number(/\(from line (\d+)\)/.exec(h?.[2] ?? "")?.[1] ?? DEFAULT_OFFSET);
  const totalLines = Number(/^(\d+) lines/.exec(h?.[2] ?? "")?.[1] ?? 0);
  // Unanchored rows carry no marker, so no rows and one empty row are the same text: a window
  // past the last line or a first line over the byte limit shows no row.
  if (!anchored && (lineTooLong || firstLine > totalLines)) bodyStart = lines.length;
  for (let i = bodyStart; i < lines.length; i++) {
    const row = anchored
      ? parseHashline(lines[i])
      : { lineNo: String(firstLine + i - bodyStart), content: lines[i] };
    if (!row) break;
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
  for (let i = 0; i < rendered.length; i++) {
    out.push(theme.fg("dim", `   ${lineNos[i]}: `) + rendered[i]);
  }

  return out.join("\n");
}

/** Build the read override (a ToolDefinition fragment for registerTool). */
export function makeReadOverride({
  cwd,
  config,
  budgets,
}: ToolEnvironment): ToolDefinition<
  ReturnType<typeof createReadToolDefinition>["parameters"],
  ReadDetails | undefined
> {
  const { hashLen } = config;
  const { defaultLimit } = config.read;
  const builtin = createReadToolDefinition(cwd);
  // A TypeBox object, not a spread of Pi's plain JSON schema: argument diagnostics pick
  // single fields from it, which needs TypeBox's own schema kinds.
  const parameters = Type.Object(
    {
      path: Type.String({ ...builtin.parameters.properties.path, minLength: 1 }),
      offset: Type.Optional(
        Type.Number({
          ...POSITIVE_SAFE_INTEGER,
          description: `1-based line to start from (default ${DEFAULT_OFFSET}). For a large file, set offset and limit to read only the relevant section.`,
        }),
      ),
      limit: Type.Optional(
        Type.Number({
          ...POSITIVE_SAFE_INTEGER,
          description: `Maximum lines to read (default ${defaultLimit}).`,
        }),
      ),
      anchors: Type.Optional(
        Type.Boolean({
          description:
            "false returns the lines alone, without LINE#HASH│ prefixes, about a third fewer tokens; edit cannot cite them. Use it for a file you will not edit (default true).",
        }),
      ),
    },
    { additionalProperties: false },
  );

  return {
    name: "read" as const,
    label: "read",
    description:
      "Read a file. Images return as attachments. Text lines show as LINE#HASH│content anchors for edit; CRLF line endings show as LF.",
    promptSnippet: "Read files with editable line anchors",
    promptGuidelines: [
      "In a codemode script, take raw file text from tools.bash (cat, git show); text read results and grep content-mode results add a header line and show CRLF as LF, and their rows carry a line prefix unless read's anchors is false.",
    ],
    parameters: parameters as typeof builtin.parameters,
    // Codemode scripts receive structuredContent: Pi's image block for a delegated image, the
    // result text otherwise.
    outputSchema: builtin.outputSchema,
    prepareArguments: createArgumentPreparer("read", parameters, undefined, budgets),
    constrainedSampling: STRICT_SAMPLING,
    renderShell: "default" as const,

    renderCall: builtin.renderCall,

    renderResult(result, options, theme, context) {
      const { isPartial, expanded } = options;
      if (isPartial) return new Text(theme.fg("warning", "Reading…"), 0, 0);
      if (context.isError) return renderToolError(result, "read", theme, expanded);
      const { content, report } = splitReport(result, "read");
      if (result.details?.nativeRead)
        return builtin.renderResult!({ ...result, content }, options, theme, context);
      // Collapsed (not expanded): show nothing — the call line carries the
      // title, matching the built-in read's fold behavior.
      if (!expanded) return new Text("", 0, 0);
      const raw = content[0]?.type === "text" ? content[0].text : "";
      return new Text(
        [
          renderReadBody(
            raw,
            String(context.args?.path ?? ""),
            (context.args as ReadInput | undefined)?.anchors !== false,
            report !== undefined && "lineTooLong" in report && report.lineTooLong !== undefined,
            theme,
          ),
          ...(report ? reportLines(report, theme) : []),
        ].join("\n"),
        0,
        0,
      );
    },

    async execute(
      toolCallId: string,
      { anchors: anchored, ...params }: ReadInput,
      signal: AbortSignal | undefined,
      onUpdate: AgentToolUpdateCallback<ReadToolDetails | undefined> | undefined,
      ctx: ExtensionToolContext,
    ) {
      const budget = budgets();
      const maxBytes =
        config.read.maxKiB === undefined ? budget.readBytes : config.read.maxKiB * 1024;
      return runTool("read", { path: params.path, signal, budget }, async () => {
        throwIfCancelled(signal);
        const start = params.offset ?? DEFAULT_OFFSET;
        const limit = params.limit ?? defaultLimit;
        const anchors = createAnchorFormatter(hashLen);
        const formatRow =
          anchored === false
            ? (_line: number, content: string) => displayCarriageReturns(content)
            : anchors.row;
        const report = { tool: "read" as const, path: params.path };
        const readNative = async () => {
          const result = await builtin.execute(toolCallId, params, signal, onUpdate, ctx);
          return {
            ...reportResult(report, result.content, {
              ...result.details,
              nativeRead: true as const,
            }),
            structuredContent: result.structuredContent,
          };
        };

        const absPath = canonicalPath(cwd, params.path);
        try {
          if (await detectSupportedImageMimeTypeFromFile(absPath)) {
            return readNative();
          }
        } catch {
          return readNative();
        }

        const rows: string[] = [];
        const crExpansion = Buffer.byteLength(displayCarriageReturns("\r")) - 1;
        let outputBytes = 0;
        let truncated = false;
        let firstLineExceedsLimit = false;
        let stats: Awaited<ReturnType<typeof scanTextLines>>;
        try {
          stats = await scanTextLines(
            absPath,
            (number) => number >= start && number - start < limit,
            (line) => {
              if (truncated) return;
              const rowBytes =
                line.byteLength +
                line.carriageReturns * crExpansion +
                Buffer.byteLength(formatRow(line.number, ""));
              const nextBytes = outputBytes + rowBytes + (rows.length > 0 ? 1 : 0);
              if (nextBytes > maxBytes) {
                truncated = true;
                firstLineExceedsLimit = rows.length === 0;
                return;
              }
              rows.push(formatRow(line.number, line.text!));
              outputBytes = nextBytes;
            },
            { signal, maxLineBytes: maxBytes },
          );
        } catch (error) {
          // Keep native filesystem diagnostics without retrying decoding or cancellation failures.
          if (!signal?.aborted && errnoCode(error) !== undefined) {
            return readNative();
          }
          throw error;
        }
        if (stats.hasNul) return readNative();
        // Rows were returned and more remain. A caller's own limit is a chosen window: its header
        // and rows already show where it ends, so only a window the extension cut (default limit
        // or byte budget) gets a report.
        const nextOffset =
          (params.limit === undefined || truncated) &&
          rows.length > 0 &&
          start + rows.length <= stats.totalLines
            ? start + rows.length
            : undefined;
        const header = `${formatReadHeader(serializePath(cwd, absPath), stats.totalLines, start, stats.finalNewline)}\n`;
        const limitText = formatByteSize(maxBytes);

        const result = reportResult(
          {
            ...report,
            nextOffset,
            outputLimit: truncated && !firstLineExceedsLimit ? limitText : undefined,
            lineTooLong: firstLineExceedsLimit ? limitText : undefined,
          },
          [{ type: "text" as const, text: header + rows.join("\n") }],
        );
        const text = result.content.flatMap((block) => (block.type === "text" ? [block.text] : []));
        return { ...result, structuredContent: text.join("\n") };
      });
    },
  };
}
