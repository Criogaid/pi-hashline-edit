/**
 * Independent file cards for nested fused calls. Pi's real child ids bind each
 * card to execution; codemode argument previews are never used as identifiers.
 * Versioned custom entries preserve bounded previews outside model context.
 */
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Box, Text } from "@earendil-works/pi-tui";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import {
  FRESHNESS_VALUES,
  MUTATION_TOOL_NAMES,
  type ActionFusionProgress,
  type MutationToolName,
} from "./action-fusion.ts";
import { MAX_BLOCK_BYTES, formatKiB } from "./budgets.ts";
import { DiagnosticBuffer } from "./diagnostic-buffer.ts";
import { renderDiffPreview, renderFreshnessWarning, renderToolError } from "./render.ts";

const CARD_TYPE = "hashline-nested-mutation";
const RESULT_TYPE = "hashline-nested-mutation-result";
const boundedString = Type.Refine(
  Type.String(),
  (text: string) => Buffer.byteLength(text) <= MAX_BLOCK_BYTES,
);
const cardSchema = Type.Object({
  version: Type.Literal(1),
  toolCallId: Type.String(),
  tool: Type.Enum(MUTATION_TOOL_NAMES),
  path: boundedString,
  status: Type.Union([
    Type.Object({ phase: Type.Literal("running") }),
    Type.Object({
      phase: Type.Literal("succeeded"),
      noChange: Type.Boolean(),
      freshness: Type.Enum(FRESHNESS_VALUES),
    }),
    Type.Object({ phase: Type.Literal("failed"), error: boundedString }),
  ]),
  preview: Type.Optional(
    Type.Object({
      summary: boundedString,
      diff: Type.Optional(boundedString),
      diffOmitted: Type.Optional(Type.Literal(true)),
    }),
  ),
});
type CardData = Static<typeof cardSchema>;

function bounded(text: string): string {
  const buffer = new DiagnosticBuffer(MAX_BLOCK_BYTES);
  buffer.append(text);
  return buffer.toString();
}

function readCard(value: unknown): CardData | undefined {
  return Value.Check(cardSchema, value) ? value : undefined;
}

function preview(result: AgentToolResult<unknown>): CardData["preview"] {
  const first = result.content.find((block) => block.type === "text");
  if (!first) return undefined;
  const details = result.details;
  const displayDiff =
    typeof details === "object" && details !== null && "displayDiff" in details
      ? details.displayDiff
      : undefined;
  const rawDiff =
    typeof details === "object" && details !== null && "diff" in details ? details.diff : undefined;
  const diff =
    typeof displayDiff === "string"
      ? displayDiff
      : typeof rawDiff === "string"
        ? rawDiff
        : undefined;
  return {
    summary: bounded(first.text.split("\n")[0]),
    ...(diff && Buffer.byteLength(diff) <= MAX_BLOCK_BYTES ? { diff } : {}),
    ...(diff && Buffer.byteLength(diff) > MAX_BLOCK_BYTES ? { diffOmitted: true } : {}),
  };
}

/** Observe only nested mutations whose progress comes from our Fusion executor. */
export function registerNestedMutationCards(pi: ExtensionAPI) {
  const calls = new Map<
    string,
    { readonly tool: MutationToolName; readonly path: string | undefined }
  >();
  const states = new Map<string, CardData>();
  const save = (data: CardData, initial = false) => {
    states.set(data.toolCallId, data);
    pi.appendEntry(initial ? CARD_TYPE : RESULT_TYPE, data);
  };
  const restore = (ctx: ExtensionContext) => {
    calls.clear();
    states.clear();
    for (const entry of ctx.sessionManager.getBranch()) {
      if (
        entry.type !== "custom" ||
        (entry.customType !== CARD_TYPE && entry.customType !== RESULT_TYPE)
      )
        continue;
      const data = readCard(entry.data);
      if (data) states.set(data.toolCallId, data);
    }
  };
  pi.on("session_start", (_event, ctx) => restore(ctx));
  pi.on("session_tree", (_event, ctx) => restore(ctx));
  pi.on("session_shutdown", () => {
    calls.clear();
    states.clear();
  });
  pi.on("tool_execution_start", (event) => {
    if (!event.parentToolCallId) return;
    const tool = MUTATION_TOOL_NAMES.find((name) => name === event.toolName);
    if (!tool) return;
    const args: unknown = event.args;
    const path =
      typeof args === "object" && args !== null && "path" in args && typeof args.path === "string"
        ? args.path
        : undefined;
    calls.set(event.toolCallId, { tool, path });
  });
  pi.on("tool_execution_update", (event) => {
    const data = states.get(event.toolCallId);
    if (!data || data.status.phase !== "succeeded" || !calls.has(event.toolCallId)) return;
    const result: AgentToolResult<unknown> = event.partialResult;
    states.set(event.toolCallId, { ...data, preview: preview(result) });
  });
  pi.on("tool_execution_end", (event) => {
    const data = states.get(event.toolCallId);
    calls.delete(event.toolCallId);
    if (!data) return;
    const result: AgentToolResult<unknown> = event.result;
    // A failure after mutation completion must not turn the completed file step red.
    save(
      data.status.phase === "succeeded"
        ? { ...data, preview: event.isError ? data.preview : preview(result) }
        : {
            ...data,
            status: {
              phase: "failed",
              error: bounded(
                result.content
                  .filter((block) => block.type === "text")
                  .map((block) => block.text)
                  .join("\n"),
              ),
            },
          },
    );
  });

  pi.registerEntryRenderer<unknown>(CARD_TYPE, (entry, { expanded }, theme) => {
    const initial = readCard(entry.data);
    if (!initial)
      return new Text(theme.fg("error", "Unsupported or invalid nested mutation card data."), 0, 0);
    const box = new Box(1, 1);
    return {
      invalidate: () => box.invalidate(),
      render(width) {
        const data = states.get(initial.toolCallId) ?? initial;
        const interrupted = data.status.phase === "running" && !calls.has(data.toolCallId);
        const phase = interrupted ? "interrupted (final status unknown)" : data.status.phase;
        const background = interrupted
          ? "customMessageBg"
          : data.status.phase === "running"
            ? "toolPendingBg"
            : data.status.phase === "failed"
              ? "toolErrorBg"
              : "toolSuccessBg";
        const color =
          data.status.phase === "succeeded"
            ? "success"
            : data.status.phase === "failed"
              ? "error"
              : "warning";
        box.setBgFn((line) => theme.bg(background, line));
        box.clear();
        box.addChild(
          new Text(
            `${theme.fg("toolTitle", theme.bold(data.tool))} ${theme.fg("accent", data.path)} · ${theme.fg(color, phase)}`,
            0,
            0,
          ),
        );
        if (data.status.phase === "failed") {
          box.addChild(
            renderToolError(
              { content: [{ type: "text", text: data.status.error }] },
              theme,
              expanded,
            ),
          );
        } else if (data.status.phase === "succeeded") {
          box.addChild(
            new Text(
              theme.fg(
                "success",
                data.preview?.summary ||
                  (data.status.noChange ? "No net change." : "File changes saved."),
              ),
              0,
              0,
            ),
          );
          if (data.preview?.diff)
            box.addChild(new Text(renderDiffPreview(data.preview.diff, expanded, theme), 0, 0));
          if (data.preview?.diffOmitted)
            box.addChild(
              new Text(
                theme.fg("dim", `Diff omitted (${formatKiB(MAX_BLOCK_BYTES)} preview limit).`),
                0,
                0,
              ),
            );
          const warning = renderFreshnessWarning(data.status.freshness, theme);
          if (warning) box.addChild(warning);
        }
        return box.render(width);
      },
    };
  });

  return (progress: ActionFusionProgress) => {
    const call = calls.get(progress.toolCallId);
    if (!call) return;
    const previous = states.get(progress.toolCallId);
    const terminal = progress.command !== "waiting" && progress.command !== "running";
    const status: CardData["status"] = progress.mutationCompleted
      ? {
          phase: "succeeded",
          noChange: progress.publication === "NOT_PUBLISHED",
          freshness: terminal ? progress.freshness : "unknown",
        }
      : terminal
        ? { phase: "failed", error: "Mutation did not complete." }
        : { phase: "running" };
    const data: CardData = {
      version: cardSchema.properties.version.const,
      toolCallId: progress.toolCallId,
      tool: call.tool,
      path: previous?.path ?? bounded(call.path ?? progress.path),
      status,
      ...(previous?.preview ? { preview: previous.preview } : {}),
    };
    // Save completion immediately so an interrupted command cannot erase a finished file step.
    if (!previous || previous.status.phase !== status.phase || terminal) save(data, !previous);
  };
}
