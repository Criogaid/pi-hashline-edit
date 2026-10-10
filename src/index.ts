/**
 * pi-hashline-edit extension entry.
 *
 * Overrides the built-in read/edit: read outputs "lineNo#hash│content";
 * edit accepts structured hashline ops (edits[] with LINE#HASH anchors), and
 * legacy oldText/newText is rejected by the schema. grep
 * is overridden the same way so results carry usable anchors. A separate
 * `replace` tool adds location-blind bulk + regex replacement (replaceAll and
 * full JS regex with capture groups) for renames/pattern transforms that
 * would need many individual edits. Each tool carries its own renderer.
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
import { registerForgetTool } from "./pi/forget-tool.ts";
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
  // read/edit/grep/replace/write stay in place, as if this package were not installed.
  if (config.enabled) {
    const budgets = registerModelBudgets(pi);
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
    if (config.forget) registerForgetTool(pi, budgets);
  }
}
