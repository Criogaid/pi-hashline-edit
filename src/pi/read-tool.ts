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
import { canonicalPath } from "./path.ts";
import { renderToolError, renderReportResult } from "./render.ts";
import {
  type ForgetReceiptDetails,
  readReceipt,
  withoutResultTag,
  withResultTag,
} from "./forget-tool.ts";
import { POSITIVE_SAFE_INTEGER } from "./schema.ts";
import { throwIfCancelled } from "./error-text.ts";
import { reportToolErrors, reportOf } from "./tool-error.ts";
import { emptyReport, type ReportDetails } from "./report.ts";
import type { ReadFact } from "../core/report-schema.ts";
import type { HashlineEditConfig } from "./config.ts";
import { createArgumentPreparer } from "./argument-validation.ts";

const DEFAULT_OFFSET = 1;

type ReadDetails = ReadToolDetails & { nativeRead?: true } & ForgetReceiptDetails &
  Partial<ReportDetails>;

/** Style payload rows without interpreting report metadata or notices. */
function renderReadBody(raw: string, path: string, theme: Theme): string {
  const lines = raw.split("\n");
  const out: string[] = [];
  const bodyStart = 0;

  // Highlight complete anchor rows; preserve foreign payload rows as plain content.
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
    out.push(theme.fg("toolOutput", lines[i]));
  }
  return out.join("\n");
}

/** Build the read override (a ToolDefinition fragment for registerTool). */
export function makeReadOverride(
  cwd: string,
  config: HashlineEditConfig,
): ToolDefinition<
  ReturnType<typeof createReadToolDefinition>["parameters"],
  ReadDetails | undefined
> {
  const { hashLen } = config;
  const { defaultLimit } = config.read;
  const maxBytes = config.read.maxKiB * 1024;
  const builtin = createReadToolDefinition(cwd);
  // A TypeBox object, not a spread of Pi's plain JSON schema: argument diagnostics pick
  // single fields from it, which needs TypeBox's own schema kinds.
  const parameters = Type.Object(
    {
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
    ],
    parameters: parameters as typeof builtin.parameters,
    prepareArguments: createArgumentPreparer("read", parameters),
    renderShell: "default" as const,

    renderCall: builtin.renderCall,

    renderResult(result, options, theme, context) {
      const { isPartial, expanded } = options;
      if (isPartial) return new Text(theme.fg("warning", "Reading…"), 0, 0);
      const report = reportOf(result);
      if (context?.isError) return renderToolError(result, theme, expanded);
      if (result.details?.nativeRead)
        return builtin.renderResult!(
          {
            ...withoutResultTag(result),
            content: [
              ...(report?.payload.map((text) => ({ type: "text" as const, text })) ?? []),
              ...result.content.filter((block) => block.type === "image"),
            ],
          },
          options,
          theme,
          context,
        );
      // Collapsed (not expanded): show nothing — the call line carries the
      // title, matching the built-in read's fold behavior.
      if (!expanded) return new Text("", 0, 0);
      return renderReportResult(result, expanded, theme, (text) =>
        renderReadBody(text, String(context.args.path), theme).split("\n"),
      );
    },

    async execute(
      toolCallId: string,
      params: ReadToolInput,
      signal: AbortSignal | undefined,
      onUpdate: AgentToolUpdateCallback<ReadToolDetails | undefined> | undefined,
      ctx: ExtensionToolContext,
    ) {
      return reportToolErrors<ReadDetails | undefined>(
        "read",
        { path: params.path, signal },
        async () => {
          throwIfCancelled(signal);
          const offset = params.offset ?? DEFAULT_OFFSET;
          const limit = params.limit ?? defaultLimit;
          const anchors = createAnchorFormatter(hashLen);
          const readNative = async () => {
            const result = await builtin.execute(toolCallId, params, signal, onUpdate, ctx);
            return withResultTag(
              toolCallId,
              {
                ...result,
                details: {
                  ...result.details,
                  nativeRead: true as const,
                  report: {
                    ...emptyReport(
                      "read",
                      result.content.flatMap((block) =>
                        block.type === "text" ? [block.text] : [],
                      ),
                    ),
                    path: params.path,
                    read: { native: true as const },
                  },
                },
              },
              config.forget,
              () =>
                readReceipt(
                  params.path,
                  result.content.some((block) => block.type === "image")
                    ? { image: true }
                    : undefined,
                ),
            );
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
                totalRows++;
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
          const nextOffset =
            !truncated && rows.length > 0 && stats.totalLines - start >= limit
              ? start + rows.length
              : undefined;

          const read: ReadFact = {
            start,
            end: rows.length ? start + rows.length - 1 : start - 1,
            totalLines: stats.totalLines,
            native: false,
            finalNewline: stats.finalNewline,
            truncated,
            maxBytes,
            omittedRows: totalRows - rows.length,
            ...(truncated && !firstLineExceedsLimit && start + rows.length <= stats.totalLines
              ? { nextOffset: start + rows.length }
              : nextOffset === undefined
                ? {}
                : { nextOffset }),
            ...(firstLineExceedsLimit ? { oversizedLine: start } : {}),
          };
          const body = rows.join("\n");

          return withResultTag(
            toolCallId,
            {
              content: [{ type: "text" as const, text: body }],
              details: {
                report: { ...emptyReport("read", [body]), path: params.path, read },
              },
            },
            config.forget,
            () =>
              readReceipt(
                params.path,
                rows.length > 0 ? { start, end: start + rows.length - 1, truncated } : undefined,
              ),
          );
        },
      );
    },
  };
}
