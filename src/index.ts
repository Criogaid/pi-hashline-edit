/**
 * pi-hashline-edit extension entry.
 *
 * Overrides Pi's built-in read, grep, edit, and write: read and grep output
 * `LINE#HASH│content` anchors, edit applies structured ops on those anchors, and
 * write publishes whole files through the same commit layer. Adds `replace`
 * (literal or JavaScript-regex replacement across a file). Each tool carries its
 * own renderer; src/pi/AGENTS.md maps the modules.
 *
 * @module pi-hashline-edit
 */

import {
  type ExtensionAPI,
  SettingsManager,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { Static, TSchema } from "typebox";
import { createRenderArguments } from "./pi/argument-validation.ts";
import { loadConfig } from "./pi/config.ts";
import { registerModelBudgets } from "./pi/model-budgets.ts";
import { makeEditOverride } from "./pi/edit-tool.ts";
import { makeReadOverride } from "./pi/read-tool.ts";
import { makeGrepOverride } from "./pi/grep-tool.ts";
import { makeReplaceTool } from "./pi/replace-tool.ts";
import { makeWriteOverride } from "./pi/write-tool.ts";
import { createActionFusionScheduler, observeFusionToolCall } from "./pi/action-fusion.ts";
import { runAlone } from "./pi/mutation-runner.ts";
import { registerFusionCards, withMutationStatus } from "./pi/fusion-card.ts";
import type { ToolGuidelines } from "./pi/schema.ts";
import { NEXT_GUIDELINE } from "./pi/report-schema.ts";
import { resolveWorkspace } from "./pi/workspace.ts";

export default async function (pi: ExtensionAPI) {
  // Replay on reload needs tools and entry renderers registered before session_start.
  const cwd = await resolveWorkspace(pi);

  // Tools capture this snapshot at registration; a reload registers them again.
  const config = loadConfig(cwd);

  // `enabled: false` leaves the extension fully inert — pi's built-in
  // read/grep/edit/write stay in place, as if this package were not installed.
  if (config.enabled) {
    const budgets = registerModelBudgets(pi);
    // Saved then_run cards render even when Action Fusion is off.
    const reportProgress = registerFusionCards(pi);
    const schedule = config.actionFusion ? createActionFusionScheduler(reportProgress) : runAlone;
    if (config.actionFusion) pi.on("tool_call", observeFusionToolCall);
    // Every tool returns a report; Pi prints this shared guideline once.
    const register = <TParams extends TSchema, TDetails, TState>(
      tool: ToolDefinition<TParams, TDetails, TState> & ToolGuidelines,
    ) => {
      const { renderCall, renderResult } = tool;
      const coerce = createRenderArguments(tool.parameters);
      const view = (args: unknown) => coerce(args) as Static<TParams>;
      const registered: ToolDefinition<TParams, TDetails, TState> = {
        ...tool,
        promptGuidelines: [...tool.promptGuidelines, NEXT_GUIDELINE],
        renderCall:
          renderCall &&
          ((args, theme, context) => {
            // Pi passes the same arguments as `args` and `context.args`.
            const viewed = view(args);
            return renderCall(viewed, theme, { ...context, args: viewed });
          }),
        renderResult:
          renderResult &&
          ((result, options, theme, context) =>
            renderResult(
              result,
              options,
              theme,
              // Error cards inspect raw arguments so coercion does not hide the caller's mistake.
              context.isError ? context : { ...context, args: view(context.args) },
            )),
      };
      pi.registerTool(registered);
    };
    const registerMutation = <TParams extends TSchema, TDetails>(
      tool: ToolDefinition<TParams, TDetails> & ToolGuidelines,
    ) => register(config.actionFusion ? withMutationStatus(tool) : tool);
    const env = { cwd, config, budgets };
    const mutationEnv = { ...env, schedule };
    registerMutation(makeWriteOverride(mutationEnv));
    registerMutation(makeEditOverride(mutationEnv));
    registerMutation(makeReplaceTool(mutationEnv));

    let autoResizeImages: boolean | undefined;
    const readAutoResize = () =>
      (autoResizeImages ??= SettingsManager.inMemory(pi.getSettings()).getImageAutoResize());
    // Pi snapshots the setting when it builds the native tool. Headless reload can skip session_start.
    pi.on("session_start", () => {
      readAutoResize();
    });
    register(makeReadOverride(env, readAutoResize));
    register(makeGrepOverride(env));
  }
}
