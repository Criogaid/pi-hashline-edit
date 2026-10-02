/**
 * Action Fusion presentation: the mutation card shell that keeps the file
 * result's status independent of the fused command, and the separate
 * transcript card for each then_run command.
 *
 * @module pi-hashline-edit/pi
 */

import type {
  ExtensionAPI,
  ExtensionContext,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { createBashToolDefinition } from "@earendil-works/pi-coding-agent";
import { Box, Container, Text, type Component } from "@earendil-works/pi-tui";
import type { TSchema } from "typebox";
import type { ActionFusionProgress } from "./action-fusion.ts";
import { renderToolError, type MutationRenderState } from "./render.ts";

const CARD_TYPE = "hashline-then-run";
const RESULT_TYPE = "hashline-then-run-result";

type CommandCardData = Pick<
  ActionFusionProgress,
  "toolCallId" | "commandText" | "command" | "output" | "reason"
>;

function commandCardData({
  toolCallId,
  commandText,
  command,
  output,
  reason,
}: ActionFusionProgress): CommandCardData {
  return { toolCallId, commandText, command, output, ...(reason ? { reason } : {}) };
}

/** Render one durable transcript card per fused command without adding model context. */
export function registerFusionCards(pi: ExtensionAPI) {
  let currentCwd = process.cwd();
  const bash = createBashToolDefinition(process.cwd());
  const states = new Map<string, CommandCardData>();
  const active = new Set<string>();

  const restore = (ctx: ExtensionContext) => {
    if (ctx.cwd) currentCwd = ctx.cwd;
    states.clear();
    active.clear();
    for (const entry of ctx.sessionManager.getBranch()) {
      if (
        entry.type !== "custom" ||
        (entry.customType !== CARD_TYPE && entry.customType !== RESULT_TYPE)
      )
        continue;
      const data = entry.data as ActionFusionProgress | undefined;
      if (
        data &&
        typeof data.toolCallId === "string" &&
        typeof data.commandText === "string" &&
        typeof data.output === "string"
      ) {
        states.set(data.toolCallId, commandCardData(data));
      }
    }
  };
  pi.on("session_start", (_event, ctx) => restore(ctx));
  pi.on("session_tree", (_event, ctx) => restore(ctx));

  pi.registerEntryRenderer<CommandCardData>(CARD_TYPE, (entry, { expanded }, theme) => {
    const initial = entry.data;
    if (!initial) return undefined;
    const statusText = new Text("", 0, 0);
    const box = new Box(1, 1);
    let call: Component | undefined;
    let result: Component | undefined;
    const rendererState = { startedAt: undefined, endedAt: undefined, interval: undefined };
    return {
      invalidate: () => box.invalidate(),
      render(width) {
        // Read live state during rendering; native tool updates schedule the repaint.
        const current = states.get(initial.toolCallId) ?? initial;
        const pending = current.command === "waiting" || current.command === "running";
        const interrupted = pending && !active.has(current.toolCallId);
        const status = interrupted ? "interrupted (final status unknown)" : current.command;
        const failed = current.command === "failed" || current.command === "timeout";
        const color =
          pending || current.command === "cancelled"
            ? "warning"
            : failed
              ? "error"
              : current.command === "succeeded"
                ? "success"
                : "dim";
        const background =
          pending && !interrupted
            ? "toolPendingBg"
            : failed
              ? "toolErrorBg"
              : current.command === "succeeded"
                ? "toolSuccessBg"
                : "customMessageBg";
        box.setBgFn((line) => theme.bg(background, line));
        statusText.setText(
          `${theme.fg("toolTitle", theme.bold("then_run"))} · ${theme.fg(color, status)}`,
        );
        const context = {
          args: { command: current.commandText },
          toolCallId: current.toolCallId,
          cwd: currentCwd,
          state: rendererState,
          invalidate: () => box.invalidate(),
          // Parent tool updates drive entry rendering; leave the native elapsed-time timer off.
          executionStarted: false,
          argsComplete: true,
          isPartial: pending && !interrupted,
          expanded,
          showImages: false,
          isError: failed,
        };
        call = bash.renderCall!(context.args, theme, { ...context, lastComponent: call });
        box.clear();
        box.addChild(statusText);
        box.addChild(call);
        if (current.reason) box.addChild(new Text(theme.fg("dim", current.reason), 0, 0));
        if (current.output || current.command === "succeeded" || failed) {
          result = bash.renderResult!(
            { content: [{ type: "text", text: current.output }], details: undefined },
            { expanded, isPartial: context.isPartial },
            theme,
            { ...context, lastComponent: result },
          );
          box.addChild(result);
        }
        return box.render(width);
      },
    };
  });

  return (progress: ActionFusionProgress, ctx?: ExtensionContext) => {
    if (ctx?.cwd) currentCwd = ctx.cwd;
    const first = !states.has(progress.toolCallId);
    const data = commandCardData(progress);
    states.set(progress.toolCallId, data);
    const pending = progress.command === "waiting" || progress.command === "running";
    if (pending) active.add(progress.toolCallId);
    else active.delete(progress.toolCallId);
    // Only endpoints are persisted; streaming snapshots reuse Bash's bounded output.
    if (first) pi.appendEntry(CARD_TYPE, data);
    if (!pending) pi.appendEntry(RESULT_TYPE, data);
  };
}

/** Mutation render state plus the shell that keeps the card status independent of then_run. */
interface FusedMutationRenderState extends MutationRenderState {
  mutationShell?: {
    box: Box;
    call?: Component;
    result?: Component;
    fileState?: { freshness?: string };
  };
}

/** Keep the mutation card's background independent of the fused command's lifetime. */
export function withMutationStatus<TParams extends TSchema, TDetails>(
  tool: ToolDefinition<TParams, TDetails, FusedMutationRenderState>,
): ToolDefinition<TParams, TDetails, FusedMutationRenderState> {
  return {
    ...tool,
    renderShell: "self",
    renderCall(args, theme, context) {
      const shell = (context.state.mutationShell ??= { box: new Box(1, 1) });
      shell.call = tool.renderCall!(args, theme, { ...context, lastComponent: shell.call });
      shell.box.clear();
      shell.box.addChild(shell.call);
      shell.box.setBgFn((line: string) =>
        theme.bg(
          context.isPartial ? "toolPendingBg" : context.isError ? "toolErrorBg" : "toolSuccessBg",
          line,
        ),
      );
      return shell.box;
    },
    renderResult(result, options, theme, context) {
      const shell = (context.state.mutationShell ??= { box: new Box(1, 1) });
      const details = result.details as
        | { actionFusion?: { mutationCompleted?: boolean; freshness?: string } }
        | undefined;
      const isPartial = options.isPartial && details?.actionFusion?.mutationCompleted !== true;
      // Pi serializes fused failures into one diagnostic; retain it when the card expands.
      const fusedError = context.isError && (context.args as { then_run?: unknown })?.then_run;
      shell.result = fusedError
        ? renderToolError(result, theme, options.expanded)
        : tool.renderResult!(result, { ...options, isPartial }, theme, {
            ...context,
            isPartial,
            lastComponent: shell.result,
          });
      // Pi runs renderCall first; update its box in place without invalidating the tool row.
      shell.box.addChild(shell.result);
      const file = details?.actionFusion ?? shell.fileState;
      if (file) {
        shell.fileState = { freshness: file.freshness };
        if (file.freshness === "changed" || file.freshness === "missing") {
          shell.box.addChild(
            new Text(theme.fg("warning", `Anchors are stale: target ${file.freshness}.`), 0, 0),
          );
        }
      }
      shell.box.setBgFn((line: string) =>
        theme.bg(
          isPartial ? "toolPendingBg" : context.isError ? "toolErrorBg" : "toolSuccessBg",
          line,
        ),
      );
      return new Container();
    },
  };
}
