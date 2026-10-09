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
import { commandTimingSchema, type ActionFusionProgress } from "./action-fusion.ts";
import { commandDetailLines, type MutationRenderState } from "./render.ts";
import { reportOf } from "./tool-error.ts";
import { mutationCompleted } from "./report.ts";
import { commandSchema } from "../core/report-schema.ts";
import { Type, type Static } from "typebox";
import { Check } from "typebox/value";

const CARD_TYPE = "hashline-then-run";
const RESULT_TYPE = "hashline-then-run-result";

const cardSchema = Type.Object({
  version: Type.Literal(1),
  toolCallId: Type.String(),
  commandText: Type.String(),
  command: commandSchema,
  timing: Type.Optional(commandTimingSchema),
});
type CommandCardData = Static<typeof cardSchema>;
// Existing sessions used an unversioned card. Convert that persisted format only at this boundary.
const legacyCardSchema = Type.Object(
  {
    toolCallId: Type.String(),
    commandText: Type.String(),
    command: commandSchema.properties.status,
    output: Type.String(),
    reason: Type.Optional(Type.String()),
    timing: Type.Optional(commandTimingSchema),
  },
  { additionalProperties: false },
);
function readCommandCard(data: unknown): CommandCardData | undefined {
  if (Check(cardSchema, data)) return data;
  if (!Check(legacyCardSchema, data)) return undefined;
  return {
    version: 1,
    toolCallId: data.toolCallId,
    commandText: data.commandText,
    command: {
      status: data.command,
      output: data.output,
      ...(data.reason
        ? { causes: [{ name: "LegacyDiagnostic", message: data.reason, depth: 0 }] }
        : {}),
    },
    ...(data.timing ? { timing: data.timing } : {}),
  };
}
function commandCardData(progress: ActionFusionProgress): CommandCardData {
  return {
    version: 1,
    toolCallId: progress.toolCallId,
    commandText: progress.commandText,
    command: progress.report.command,
    ...(progress.timing ? { timing: progress.timing } : {}),
  };
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
      const data = readCommandCard(entry.data);
      if (data) states.set(data.toolCallId, data);
    }
  };
  pi.on("session_start", (_event, ctx) => restore(ctx));
  pi.on("session_tree", (_event, ctx) => restore(ctx));

  pi.registerEntryRenderer<unknown>(CARD_TYPE, (entry, { expanded }, theme) => {
    const initial = readCommandCard(entry.data);
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
        const pending =
          current.command.status === "waiting" || current.command.status === "running";
        const interrupted = pending && !active.has(current.toolCallId);
        const status = interrupted ? "interrupted (final status unknown)" : current.command.status;
        const countdown =
          current.command.status === "running" && !interrupted && current.timing
            ? ` · ${current.timing.remainingSeconds}s remaining`
            : "";
        const failed = current.command.status === "failed" || current.command.status === "timeout";
        const color =
          pending || current.command.status === "cancelled"
            ? "warning"
            : failed
              ? "error"
              : current.command.status === "succeeded"
                ? "success"
                : "dim";
        const background =
          pending && !interrupted
            ? "toolPendingBg"
            : failed
              ? "toolErrorBg"
              : current.command.status === "succeeded"
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
        for (const line of commandDetailLines(current.command, theme))
          box.addChild(new Text(line, 0, 0));
        if (current.command.output || current.command.status === "succeeded" || failed) {
          result = bash.renderResult!(
            { content: [{ type: "text", text: current.command.output }], details: undefined },
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
    const pending =
      progress.report.command.status === "waiting" || progress.report.command.status === "running";
    if (pending) active.add(progress.toolCallId);
    else active.delete(progress.toolCallId);
    // Only endpoints are persisted; streaming snapshots reuse Bash's bounded output.
    if (first) pi.appendEntry(CARD_TYPE, data);
    if (!pending) pi.appendEntry(RESULT_TYPE, data);
  };
}

type MutationCardProgress = Pick<ActionFusionProgress, "mutationCompleted">;

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
      const report = reportOf(result);
      const file = report?.mutation
        ? { mutationCompleted: mutationCompleted(report) }
        : shell.fileState;
      const isPartial = mutationPending(options.isPartial, file);
      // The transcript command card displays command facts; this card projects the mutation facts.
      const fileReport = report && (({ command: _command, ...file }) => file)(report);
      const displayed = fileReport
        ? { ...result, details: Object.assign({}, result.details, { report: fileReport }) }
        : result;
      shell.result = tool.renderResult!(displayed, { ...options, isPartial }, theme, {
        ...context,
        isPartial,
        lastComponent: shell.result,
      });
      // Pi runs renderCall first; update its box in place without invalidating the tool row.
      shell.box.addChild(shell.result);
      if (file) shell.fileState = file;
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
