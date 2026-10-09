/**
 * Action Fusion presentation: the mutation card follows file mutation completion;
 * a separate transcript card follows each then_run command's output and outcome.
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
import type { MutationRenderState } from "./render.ts";

const CARD_TYPE = "hashline-then-run";
const RESULT_TYPE = "hashline-then-run-result";

type CommandCardData = Pick<
  ActionFusionProgress,
  "toolCallId" | "commandText" | "command" | "output" | "timing" | "mutationCompleted" | "freshness"
>;

function commandCardData({
  toolCallId,
  commandText,
  command,
  output,
  timing,
  mutationCompleted,
  freshness,
}: ActionFusionProgress): CommandCardData {
  return {
    toolCallId,
    commandText,
    command,
    output,
    mutationCompleted,
    freshness,
    ...(timing ? { timing } : {}),
  };
}

const TARGET_STATE = {
  changed: "the target changed after the mutation",
  missing: "the target is missing after the mutation",
  unknown: "the target revision could not be read",
} as const;

/**
 * Why a command never started, derived from the same facts the mutation result
 * states: whether the mutation completed and the target's freshness.
 */
function notRunReason(card: CommandCardData): string | undefined {
  if (card.command === "cancelled" && !card.output) return "Not run: cancelled.";
  if (card.command !== "skipped") return undefined;
  // Cards saved before these facts were recorded carry neither and show no reason.
  const { mutationCompleted, freshness } = card as Partial<CommandCardData>;
  if (mutationCompleted === undefined) return undefined;
  if (!mutationCompleted) return "Not run: the mutation did not complete.";
  return freshness === undefined || freshness === "unchanged"
    ? undefined
    : `Not run: ${TARGET_STATE[freshness]}.`;
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
        const countdown =
          current.command === "running" && !interrupted && current.timing
            ? ` · ${current.timing.remainingSeconds}s remaining`
            : "";
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
          `${theme.fg("toolTitle", theme.bold("then_run"))} · ${theme.fg(color, status + countdown)}`,
        );
        const context = {
          args: {
            command: current.commandText,
            ...(current.timing ? { timeout: current.timing.timeoutSeconds } : {}),
          },
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
        const reason = notRunReason(current);
        if (reason) box.addChild(new Text(theme.fg("dim", reason), 0, 0));
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

type MutationCardProgress = Partial<Pick<ActionFusionProgress, "mutationCompleted">>;

function mutationPending(isPartial: boolean, progress?: MutationCardProgress): boolean {
  return isPartial && progress?.mutationCompleted !== true;
}

/** Mutation render state plus the shell that keeps the card status independent of then_run. */
interface FusedMutationRenderState extends MutationRenderState {
  mutationShell?: {
    box: Box;
    call?: Component;
    result?: Component;
    fileState?: MutationCardProgress;
  };
}

/** Finish the mutation card independently while the fused command remains active. */
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
          mutationPending(context.isPartial, shell.fileState)
            ? "toolPendingBg"
            : context.isError
              ? "toolErrorBg"
              : "toolSuccessBg",
          line,
        ),
      );
      return shell.box;
    },
    renderResult(result, options, theme, context) {
      const shell = (context.state.mutationShell ??= { box: new Box(1, 1) });
      // Fusion updates carry progress alongside TDetails; final results carry only the outcome.
      const details = result.details as { actionFusion?: MutationCardProgress } | undefined;
      const file = details?.actionFusion ?? shell.fileState;
      const isPartial = mutationPending(options.isPartial, file);
      // The tool's renderer shows failures and the report's freshness facts.
      shell.result = tool.renderResult!(result, { ...options, isPartial }, theme, {
        ...context,
        isPartial,
        lastComponent: shell.result,
      });
      // Pi runs renderCall first; update its box in place without invalidating the tool row.
      shell.box.addChild(shell.result);
      if (file) shell.fileState = { mutationCompleted: file.mutationCompleted };
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
