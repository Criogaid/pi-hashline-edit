/**
 * Action Fusion presentation: the mutation card follows file mutation completion;
 * a separate transcript card follows each then_run command's output and outcome.
 *
 * @module pi-hashline-edit/pi
 */

import type {
  ExtensionAPI,
  ExtensionContext,
  ThemeBg,
  ThemeColor,
  ToolDefinition,
  ToolRenderers,
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
import type { TSchema } from "typebox";
import { Value } from "typebox/value";
import { ACTION_FUSION_PROGRESS_SCHEMA, type ActionFusionProgress } from "./report-schema.ts";
import type { MutationRenderState } from "./render.ts";

const CARD_TYPE = "hashline-then-run";
const RESULT_TYPE = "hashline-then-run-result";

type CommandCardData = ActionFusionProgress;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function decodeCard(read: () => unknown): CommandCardData | undefined {
  try {
    const source = read();
    if (!isRecord(source)) return undefined;
    const card = { ...source };
    if (isRecord(card.result)) {
      const result = { ...card.result };
      const details = result.details;
      // Pi's Bash renderer reads the output path and these truncation fields.
      if (isRecord(details)) {
        const { fullOutputPath, truncation } = details;
        result.details = JSON.parse(
          JSON.stringify({
            fullOutputPath,
            truncation: isRecord(truncation)
              ? {
                  truncated: truncation.truncated,
                  truncatedBy: truncation.truncatedBy,
                  outputLines: truncation.outputLines,
                  totalLines: truncation.totalLines,
                  maxBytes: truncation.maxBytes,
                }
              : undefined,
          }),
        );
      } else {
        delete result.details;
      }
      card.result = result;
    }
    const data: unknown = structuredClone(card);
    if (!Value.Check(ACTION_FUSION_PROGRESS_SCHEMA, data)) return undefined;
    const content = data.result?.content;
    // Pi calls array methods outside its renderer guard. Accept only dense, indexed content.
    if (content) {
      const keys = Object.keys(content);
      if (keys.length !== content.length || keys.some((key, i) => key !== String(i)))
        return undefined;
    }
    return data;
  } catch {
    // Foreign entries may throw during access, cloning, or schema inspection.
    return undefined;
  }
}

const commandPending = ({ command }: CommandCardData) =>
  command === "waiting" || command === "running";
const commandFailed = ({ command }: CommandCardData) =>
  command === "failed" || command === "timeout";

const INTERRUPTED = "interrupted (final status unknown)";
type DisplayState = CommandCardData["command"] | typeof INTERRUPTED;
const CARD_COLORS = {
  waiting: ["warning", "toolPendingBg"],
  running: ["warning", "toolPendingBg"],
  [INTERRUPTED]: ["warning", "customMessageBg"],
  cancelled: ["warning", "customMessageBg"],
  failed: ["error", "toolErrorBg"],
  timeout: ["error", "toolErrorBg"],
  succeeded: ["success", "toolSuccessBg"],
  skipped: ["dim", "customMessageBg"],
} satisfies Record<DisplayState, [ThemeColor, ThemeBg]>;

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
  // A cancelled command that started has a result, even an empty one.
  if (card.command === "cancelled" && card.result === undefined) return "Not run: cancelled.";
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
    currentCwd = ctx.cwd;
    states.clear();
    active.clear();
    cards.clear();
    for (const entry of ctx.sessionManager.getBranch()) {
      const data = decodeCard(() =>
        entry.type === "custom" &&
        (entry.customType === CARD_TYPE || entry.customType === RESULT_TYPE)
          ? entry.data
          : undefined,
      );
      if (data) states.set(data.toolCallId, data);
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

  function renderCard(initial: CommandCardData, expanded: boolean): Component {
    if (!tui) {
      // Pi may rebuild history before session_start supplies its UI context.
      let component: Component | undefined;
      const ready = () => (component ??= tui ? renderCard(initial, expanded) : undefined);
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
      const box = new Box(0, 1);
      let call: Component | undefined;
      let result: Component | undefined;
      const renderers: ToolRenderers = {
        renderShell: "self",
        renderCall(_args, theme, context) {
          box.setPaddingX(context.outputPad);
          const value = current();
          const args = { command: value.commandText, timeout: value.timing?.timeoutSeconds };
          const status =
            commandPending(value) && !active.has(value.toolCallId) ? INTERRUPTED : value.command;
          const countdown =
            status === "running" && value.timing
              ? ` · ${value.timing.remainingSeconds}s remaining`
              : "";
          const [color, background] = CARD_COLORS[status];
          box.setBgFn((line) => theme.bg(background, line));
          statusText.setText(
            `${theme.fg("toolTitle", theme.bold("then_run"))} · ${theme.fg(color, status + countdown)}`,
          );
          call = bash.renderCall!(args, theme, { ...context, args, lastComponent: call });
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
              args: { command: current().commandText, timeout: current().timing?.timeoutSeconds },
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
              isError: commandFailed(value),
            },
            commandPending(value) && active.has(value.toolCallId),
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
    card.setOutputPad(settings.getOutputPad());
    card.setShowImages(settings.getShowImages());
    card.setImageWidthCells(settings.getImageWidthCells());
    card.setGlobalExpanded(expanded);
    return card;
  }

  pi.registerEntryRenderer(CARD_TYPE, (entry, { expanded }) => {
    const data = decodeCard(() => entry.data);
    return data && renderCard(data, expanded);
  });

  return (input: ActionFusionProgress) => {
    const progress = decodeCard(() => input);
    if (!progress) throw new Error("Invalid then_run card progress.");
    const first = !states.has(progress.toolCallId);
    states.set(progress.toolCallId, progress);
    const pending = commandPending(progress);
    if (pending) active.add(progress.toolCallId);
    else active.delete(progress.toolCallId);
    // Only endpoints are persisted; streaming snapshots reuse Bash's bounded output.
    if (first) pi.appendEntry(CARD_TYPE, structuredClone(progress));
    if (!pending) pi.appendEntry(RESULT_TYPE, structuredClone(progress));
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
      const shell = (context.state.mutationShell ??= { box: new Box(context.outputPad, 1) });
      shell.box.setPaddingX(context.outputPad);
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
      const shell = (context.state.mutationShell ??= { box: new Box(context.outputPad, 1) });
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
