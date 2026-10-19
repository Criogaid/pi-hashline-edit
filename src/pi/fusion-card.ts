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
import {
  createBashToolDefinition,
  SettingsManager,
  ToolExecutionComponent,
} from "@earendil-works/pi-coding-agent";
import {
  Box,
  Container,
  Text,
  type Component,
  type TUI,
  type TuiMouseEvent,
} from "@earendil-works/pi-tui";
import { Type, type Static, type TSchema } from "typebox";
import { Value } from "typebox/value";
import { ACTION_FUSION_PROGRESS_SCHEMA } from "./report-schema.ts";
import type { ActionFusionProgress } from "./action-fusion.ts";
import { commandText } from "./mutation-result.ts";
import type { MutationRenderState } from "./render.ts";

const CARD_TYPE = "hashline-then-run";
const RESULT_TYPE = "hashline-then-run-result";

const CARD_PROPERTIES = ACTION_FUSION_PROGRESS_SCHEMA.properties;
const COMMAND_CARD_SCHEMA = Type.Object(
  {
    toolCallId: CARD_PROPERTIES.toolCallId,
    commandText: CARD_PROPERTIES.commandText,
    command: CARD_PROPERTIES.command,
    result: CARD_PROPERTIES.result,
    timing: CARD_PROPERTIES.timing,
    mutationCompleted: CARD_PROPERTIES.mutationCompleted,
    freshness: CARD_PROPERTIES.freshness,
  },
  { additionalProperties: false },
);
type CommandCardData = Static<typeof COMMAND_CARD_SCHEMA>;

function commandCardData({
  toolCallId,
  commandText,
  command,
  result,
  timing,
  mutationCompleted,
  freshness,
}: ActionFusionProgress): CommandCardData {
  return {
    toolCallId,
    commandText,
    command,
    mutationCompleted,
    freshness,
    ...(timing ? { timing } : {}),
    ...(result ? { result } : {}),
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
  if (card.command === "cancelled" && !(card.result && commandText(card.result.content)))
    return "Not run: cancelled.";
  if (card.command !== "skipped") return undefined;
  const { mutationCompleted, freshness } = card;
  if (!mutationCompleted) return "Not run: the mutation did not complete.";
  return freshness === "unchanged" ? undefined : `Not run: ${TARGET_STATE[freshness]}.`;
}

/** Adapt Pi's tool row spacing to the spacer already owned by a custom entry. */
class CommandEntryComponent extends ToolExecutionComponent {
  private globalExpanded?: boolean;
  private readonly refresh: () => void;

  constructor(
    refresh: (card: ToolExecutionComponent) => void,
    ...args: ConstructorParameters<typeof ToolExecutionComponent>
  ) {
    super(...args);
    this.refresh = () => refresh(this);
  }

  setGlobalExpanded(expanded: boolean) {
    if (this.globalExpanded === expanded) return;
    this.globalExpanded = expanded;
    this.setExpanded(expanded);
  }

  override render(width: number) {
    this.refresh();
    return super.render(width).slice(1);
  }

  override handleMouse(event: TuiMouseEvent) {
    return super.handleMouse({ ...event, y: event.y + 1, height: event.height + 1 });
  }
}

/** Render one durable transcript card per fused command without adding model context. */
export function registerFusionCards(pi: ExtensionAPI) {
  let currentCwd = process.cwd();
  const bash = createBashToolDefinition(process.cwd());
  const states = new Map<string, CommandCardData>();
  const active = new Set<string>();
  const cards = new Map<string, CommandEntryComponent>();
  let tui: TUI | undefined;

  const restore = (ctx: ExtensionContext) => {
    if (ctx.cwd) currentCwd = ctx.cwd;
    states.clear();
    active.clear();
    cards.clear();
    for (const entry of ctx.sessionManager.getBranch()) {
      if (
        entry.type !== "custom" ||
        (entry.customType !== CARD_TYPE && entry.customType !== RESULT_TYPE)
      )
        continue;
      const data = entry.data;
      if (Value.Check(COMMAND_CARD_SCHEMA, data)) states.set(data.toolCallId, data);
    }
  };
  pi.on("session_start", (_event, ctx) => {
    restore(ctx);
    tui = undefined;
    if (ctx.mode !== "tui") return;
    // The public widget factory supplies the session TUI without changing its header or editor.
    const bridge = "hashline-then-run-ui";
    ctx.ui.setWidget(
      bridge,
      (sessionTui) => {
        tui = sessionTui;
        return new Container();
      },
      { placement: "belowEditor" },
    );
    ctx.ui.setWidget(bridge, undefined);
  });
  pi.on("session_tree", (_event, ctx) => restore(ctx));

  pi.registerEntryRenderer<CommandCardData>(CARD_TYPE, function renderCard(entry, { expanded }):
    | Component
    | undefined {
    const initial = entry.data;
    if (!Value.Check(COMMAND_CARD_SCHEMA, initial)) return undefined;
    if (!tui) {
      // Pi may rebuild history before session_start supplies its UI context.
      let component: Component | undefined;
      const ready = () => (component ??= tui ? renderCard(entry, { expanded }) : undefined);
      return {
        render: (width) => ready()?.render(width) ?? [],
        invalidate: () => component?.invalidate(),
        handleMouse: (event) => ready()?.handleMouse?.(event),
      };
    }
    let card = cards.get(initial.toolCallId);
    const settings = SettingsManager.inMemory(pi.getSettings());
    if (!card) {
      const current = () => states.get(initial.toolCallId) ?? initial;
      const statusText = new Text("", 0, 0);
      let outputPadding = settings.getOutputPad();
      let box = new Box(outputPadding, 1);
      let call: Component | undefined;
      let result: Component | undefined;
      const renderers: Pick<typeof bash, "renderShell" | "renderCall" | "renderResult"> = {
        renderShell: "self",
        renderCall(args, theme, context) {
          const padding = SettingsManager.inMemory(pi.getSettings()).getOutputPad();
          if (padding !== outputPadding) {
            outputPadding = padding;
            box = new Box(outputPadding, 1);
          }
          const value = current();
          const pending = value.command === "waiting" || value.command === "running";
          const interrupted = pending && !active.has(value.toolCallId);
          const status = interrupted ? "interrupted (final status unknown)" : value.command;
          const countdown =
            value.command === "running" && !interrupted && value.timing
              ? ` · ${value.timing.remainingSeconds}s remaining`
              : "";
          const failed = value.command === "failed" || value.command === "timeout";
          const color =
            pending || value.command === "cancelled"
              ? "warning"
              : failed
                ? "error"
                : value.command === "succeeded"
                  ? "success"
                  : "dim";
          const background =
            pending && !interrupted
              ? "toolPendingBg"
              : failed
                ? "toolErrorBg"
                : value.command === "succeeded"
                  ? "toolSuccessBg"
                  : "customMessageBg";
          box.setBgFn((line) => theme.bg(background, line));
          statusText.setText(
            `${theme.fg("toolTitle", theme.bold("then_run"))} · ${theme.fg(color, status + countdown)}`,
          );
          call = bash.renderCall!(args, theme, { ...context, lastComponent: call });
          box.clear();
          box.addChild(statusText);
          box.addChild(call);
          const reason = notRunReason(value);
          if (reason) box.addChild(new Text(theme.fg("dim", reason), 0, 0));
          return box;
        },
        renderResult(value, options, theme, context) {
          // Every command that ran or failed to start has a result; waiting and skipped ones do not.
          if (current().result) {
            result = bash.renderResult!(value, options, theme, {
              ...context,
              lastComponent: result,
            });
            box.addChild(result);
          }
          return new Container();
        },
      };
      let rendered: CommandCardData | undefined;
      card = new CommandEntryComponent(
        (native) => {
          const value = current();
          if (rendered === value) return;
          rendered = value;
          native.updateArgs({
            command: value.commandText,
            ...(value.timing ? { timeout: value.timing.timeoutSeconds } : {}),
          });
          native.updateResult(
            {
              ...(value.result ?? { content: [] }),
              isError: value.command === "failed" || value.command === "timeout",
            },
            (value.command === "waiting" || value.command === "running") &&
              active.has(value.toolCallId),
          );
        },
        "bash",
        initial.toolCallId,
        { command: initial.commandText },
        {
          showImages: settings.getShowImages(),
          imageWidthCells: settings.getImageWidthCells(),
        },
        renderers,
        tui,
        currentCwd,
      );
      card.setArgsComplete();
      cards.set(initial.toolCallId, card);
    }
    card.setShowImages(settings.getShowImages());
    card.setImageWidthCells(settings.getImageWidthCells());
    card.setGlobalExpanded(expanded);
    return card;
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

type MutationCardTool<TParams extends TSchema, TDetails, TRenderDetails> = Omit<
  ToolDefinition<TParams, TDetails, FusedMutationRenderState>,
  "renderResult"
> &
  Pick<ToolDefinition<TParams, TRenderDetails, FusedMutationRenderState>, "renderResult">;

/** Finish the mutation card independently while the fused command remains active. */
export function withMutationStatus<
  TParams extends TSchema,
  TDetails extends TRenderDetails,
  TRenderDetails,
>(
  tool: MutationCardTool<TParams, TDetails, TRenderDetails>,
): MutationCardTool<TParams, TDetails, TRenderDetails> {
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
