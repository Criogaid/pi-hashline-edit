/**
 * Override read: recognized images and NUL-containing files delegate to Pi's
 * built-in read; other valid UTF-8 text is a header and anchored rows, or with
 * `anchors: false` the lines alone.
 *
 * Hashes are computed from the current content on the fly — nothing is stored.
 * The hash is `(line number, content)`, recomputed and checked at edit time, so
 * no snapshot is needed to verify an anchor later.
 *
 * @module pi-hashline-edit/pi
 */

import { constants } from "node:fs";
import { access, readFile, stat } from "node:fs/promises";
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
import { IsString, IsUnion, Type, type TSchema } from "typebox";
import { scanTextLines } from "./text-stream.ts";
import { createAnchorFormatter, displayCarriageReturns, parseHashline } from "./anchor-format.ts";
import { canonicalPath, serializePath } from "./path.ts";
import { renderToolError, reportLines, splitReport } from "./render.ts";
import { POSITIVE_SAFE_INTEGER, STRICT_SAMPLING } from "./schema.ts";
import { HashlineError, PATH_ERROR_MESSAGES } from "../core/errors.ts";
import { callSignal, throwIfCancelled } from "./error-text.ts";
import { reportResult, runTool, type ReportDetails } from "./report.ts";
import { SCRIPT_OUTPUT_SCHEMAS } from "./report-schema.ts";
import { formatByteSize, type OutputBudgets } from "./budgets.ts";
import type { ToolEnvironment } from "./config.ts";
import { createArgumentPreparer } from "./argument-validation.ts";

const DEFAULT_OFFSET = 1;

/**
 * Pi's read details for a delegated native read; the report states this read's own facts.
 * `header` is the header line of a read with `anchors: false`: the TUI shows it and the
 * result text omits it.
 */
type ReadDetails = (ReadToolDetails & { nativeRead?: true; header?: string }) &
  Partial<ReportDetails>;

/** Pi's read arguments plus this override's own. */
type ReadInput = ReadToolInput & { anchors?: boolean };

/** This read's output schema: its own text result, and each result of Pi's read other than plain text. */
function readOutputSchema(native: TSchema | undefined): TSchema {
  const nativeVariants = native !== undefined && IsUnion(native) ? native.anyOf : [];
  return Type.Union([
    SCRIPT_OUTPUT_SCHEMAS.read,
    ...nativeVariants.filter((variant) => !IsString(variant)),
  ]);
}

/**
 * Header line: `<path> · <N> line(s)`, optionally ` (from line <offset>)` and
 * ` · no trailing newline`. A missing final newline is a byte-level fact the
 * numbered rows cannot show, so the header, which the model never copies into an
 * edit `lines`, states it. An anchored read's text starts with this line; a read with
 * `anchors: false` carries it in `details`. READ_HEADER is the TUI's parser for this
 * exact line.
 */
function formatReadHeader(
  path: string,
  totalLines: number,
  start: number,
  finalNewline: boolean,
): string {
  const shownFrom = start > DEFAULT_OFFSET ? ` (from line ${start})` : "";
  const count = `${totalLines} line${totalLines === 1 ? "" : "s"}`;
  return `${path} · ${count}${shownFrom}${finalNewline ? "" : " · no trailing newline"}`;
}
const READ_HEADER = /^(.+?) · (\d+ lines?(?: \(from line \d+\))?(?: · no trailing newline)?)$/s;

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

  // Header: "<path> · <N> line(s)", optionally followed by " (from line <offset>)"
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
  const totalLines = Number(/^(\d+) lines?/.exec(h?.[2] ?? "")?.[1] ?? 0);
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
  // Line numbers ascend, so the last one is the widest.
  const lineNoWidth = lineNos.at(-1)?.length ?? 0;
  for (let i = 0; i < rendered.length; i++) {
    out.push(theme.fg("dim", `   ${lineNos[i].padStart(lineNoWidth)}: `) + rendered[i]);
  }

  return out.join("\n");
}

const BYTES_PER_KIB = 1024;

/** Where a read window ended: the file's end, a line limit, the byte budget, or its first line. */
type WindowEnd =
  | { readonly kind: "fileEnd" }
  | { readonly kind: "lineLimit"; readonly nextOffset: number; readonly callerLimit: boolean }
  | { readonly kind: "byteLimit"; readonly nextOffset: number }
  | { readonly kind: "firstLineTooLong" };

/**
 * The report facts a window end states. A caller's line limit alone tells the model where its
 * window ended, so the text states no continuation for it; scripts receive nextOffset either way.
 */
function windowFacts(end: WindowEnd, limitText: string) {
  switch (end.kind) {
    case "fileEnd":
      return { stated: {}, implied: {} };
    case "lineLimit":
      return end.callerLimit
        ? { stated: {}, implied: { nextOffset: end.nextOffset } }
        : { stated: { nextOffset: end.nextOffset }, implied: {} };
    case "byteLimit":
      return { stated: { nextOffset: end.nextOffset, outputLimit: limitText }, implied: {} };
    case "firstLineTooLong":
      return { stated: { lineTooLong: limitText }, implied: {} };
  }
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
  const { defaultLimit, maxKiB } = config.read;
  // An explicit read.maxKiB caps read output; otherwise the selected model's budget does.
  const readCap =
    maxKiB === undefined
      ? (budget: OutputBudgets) => budget.readBytes
      : () => maxKiB * BYTES_PER_KIB;
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
            "false returns the lines as they are in the file, with no header or LINE#HASH│ prefixes, for text you will read or parse but not edit; about a third fewer tokens (default true).",
        }),
      ),
    },
    { additionalProperties: false },
  );

  return {
    name: "read" as const,
    label: "read",
    description:
      "Read a file's text; images return as attachments. Lines show as LINE#HASH│content anchors for edit after one header line; anchors: false returns the lines alone. CRLF line endings show as LF and standalone CR as ␍.",
    promptSnippet: "Read file text, with line anchors for edit",
    promptGuidelines: ["Files containing NUL go to native read without a Hashline header."],
    parameters: parameters as typeof builtin.parameters,
    // Scripts receive the report's object for text, and Pi's image block for a delegated image.
    outputSchema: readOutputSchema(builtin.outputSchema),
    prepareArguments: createArgumentPreparer("read", parameters, undefined, budgets),
    constrainedSampling: STRICT_SAMPLING,
    renderShell: "default" as const,

    renderCall: builtin.renderCall,

    renderResult(result, options, theme, context) {
      const { isPartial, expanded } = options;
      if (isPartial) return new Text(theme.fg("warning", "Reading…"), 0, 0);
      if (context.isError) return renderToolError(result, "read", theme, expanded, context);
      const { content, report } = splitReport(result, "read");
      if (result.details?.nativeRead)
        return builtin.renderResult!({ ...result, content }, options, theme, context);
      // Collapsed (not expanded): show nothing — the call line carries the
      // title, matching the built-in read's fold behavior.
      if (!expanded) return new Text("", 0, 0);
      // The payload is the first block and a report follows it only when it states a fact, so
      // text that equals a report with no facts (`{}`) is the payload, not the block to strip.
      const payload = result.content[0];
      const text = payload?.type === "text" ? payload.text : "";
      // Only a read with `anchors: false` carries its header in details, which records the call
      // that ran; arguments Pi cannot coerce do not describe it.
      const header = result.details?.header;
      return new Text(
        [
          renderReadBody(
            header === undefined ? text : `${header}\n${text}`,
            String(context.args?.path ?? ""),
            header === undefined,
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
      piSignal: AbortSignal | undefined,
      onUpdate: AgentToolUpdateCallback<ReadToolDetails | undefined> | undefined,
      ctx: ExtensionToolContext,
    ) {
      const signal = callSignal(piSignal);
      const budget = budgets();
      const maxBytes = readCap(budget);
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
        const absPath = canonicalPath(cwd, params.path);
        const readNative = async () => {
          // Bind I/O to our target: native resolution may normalize or try filename variants.
          const native = createReadToolDefinition(cwd, {
            operations: {
              access: () => access(absPath, constants.R_OK),
              readFile: () => readFile(absPath),
              detectImageMimeType: () => detectSupportedImageMimeTypeFromFile(absPath),
            },
          });
          const result = await native.execute(
            toolCallId,
            { ...params, path: absPath },
            piSignal,
            onUpdate,
            ctx,
          );
          const delegated = reportResult(report, result.content, budget, {
            details: { ...result.details, nativeRead: true as const },
          });
          // Pi gives scripts an image as its image block; delegated text is the report's `text`.
          const image = result.structuredContent;
          return typeof image === "object" && image !== null
            ? { ...delegated, structuredContent: image }
            : delegated;
        };

        // Opening a FIFO or device can block before any cancellation check runs.
        if (!(await stat(absPath)).isFile()) {
          throw new HashlineError("NOT_REGULAR_FILE", PATH_ERROR_MESSAGES.NOT_REGULAR_FILE);
        }
        if (await detectSupportedImageMimeTypeFromFile(absPath)) return readNative();

        const rows: string[] = [];
        const crExpansion = Buffer.byteLength(displayCarriageReturns("\r")) - 1;
        let outputBytes = 0;
        let budgetExceeded = false;
        const stats = await scanTextLines(
          absPath,
          (number) => !budgetExceeded && number >= start && number - start < limit,
          ({ number, byteLength, carriageReturns, text }) => {
            const rowBytes =
              byteLength + carriageReturns * crExpansion + Buffer.byteLength(formatRow(number, ""));
            const nextBytes = outputBytes + rowBytes + (rows.length > 0 ? 1 : 0);
            // A line without text is longer than the whole budget.
            if (text === undefined || nextBytes > maxBytes) {
              budgetExceeded = true;
              return;
            }
            rows.push(formatRow(number, text));
            outputBytes = nextBytes;
          },
          { signal, maxLineBytes: maxBytes },
        );
        if (stats.hasNul) return readNative();
        // Rows without a header show no rows and one empty row as the same text, so a window that
        // starts past the last line is a failure. An empty file read from its first line is empty text.
        if (anchored === false && start > Math.max(stats.totalLines, DEFAULT_OFFSET)) {
          throw new HashlineError("OFFSET_PAST_END", "Offset is past the last line.", {
            facts: { totalLines: stats.totalLines },
            ...(stats.totalLines === 0 ? { next: "emptyFile" as const } : {}),
          });
        }
        const nextOffset = start + rows.length;
        const windowEnd: WindowEnd = budgetExceeded
          ? rows.length === 0
            ? { kind: "firstLineTooLong" }
            : { kind: "byteLimit", nextOffset }
          : rows.length > 0 && nextOffset <= stats.totalLines
            ? { kind: "lineLimit", nextOffset, callerLimit: params.limit !== undefined }
            : { kind: "fileEnd" };
        const { stated, implied } = windowFacts(windowEnd, formatByteSize(maxBytes));
        const header = formatReadHeader(
          serializePath(cwd, absPath),
          stats.totalLines,
          start,
          stats.finalNewline,
        );
        const text = anchored === false ? rows.join("\n") : `${header}\n${rows.join("\n")}`;

        return reportResult({ ...report, ...stated }, [{ type: "text" as const, text }], budget, {
          details: anchored === false ? { header } : undefined,
          implied,
        });
      });
    },
  };
}
