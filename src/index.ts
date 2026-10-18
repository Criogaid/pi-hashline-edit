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

import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { TSchema } from "typebox";
import { loadConfig } from "./pi/config.ts";
import { registerModelBudgets } from "./pi/model-budgets.ts";
import { makeEditOverride } from "./pi/edit-tool.ts";
import { makeReadOverride } from "./pi/read-tool.ts";
import { makeGrepOverride } from "./pi/grep-tool.ts";
import { makeReplaceTool } from "./pi/replace-tool.ts";
import { makeWriteOverride } from "./pi/write-tool.ts";
import { createActionFusionExecutor } from "./pi/action-fusion.ts";
import { registerFusionCards, withMutationStatus } from "./pi/fusion-card.ts";
import { NEXT_GUIDELINE } from "./pi/report-schema.ts";

export default function (pi: ExtensionAPI) {
  const cwd = process.cwd();

  // Tools capture this snapshot at registration; a reload registers them again.
  const config = loadConfig(cwd);

  // `enabled: false` leaves the extension fully inert — pi's built-in
  // read/grep/edit/write stay in place, as if this package were not installed.
  if (config.enabled) {
    const budgets = registerModelBudgets(pi);
    // Saved then_run cards render even when Action Fusion is now off.
    const reportProgress = registerFusionCards(pi);
    const fusion = config.actionFusion
      ? createActionFusionExecutor(undefined, reportProgress)
      : undefined;
    // Every tool returns a report; Pi prints this shared guideline once.
    const register = <TParams extends TSchema, TDetails, TState>(
      tool: ToolDefinition<TParams, TDetails, TState>,
    ) =>
      pi.registerTool({
        ...tool,
        promptGuidelines: [...(tool.promptGuidelines ?? []), NEXT_GUIDELINE],
      });
    const registerMutation = <TParams extends TSchema, TDetails>(
      tool: ToolDefinition<TParams, TDetails>,
    ) => register(fusion ? withMutationStatus(tool) : tool);
    registerMutation(makeWriteOverride(cwd, fusion, budgets));
    registerMutation(makeEditOverride(cwd, config, fusion, budgets));
    registerMutation(makeReplaceTool(cwd, config, fusion, budgets));

    register(makeReadOverride(cwd, config, budgets));
    register(makeGrepOverride(cwd, config, budgets));
  }
}
