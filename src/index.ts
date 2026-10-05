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
import { makeEditOverride } from "./pi/edit-tool.ts";
import { makeReadOverride } from "./pi/read-tool.ts";
import { makeGrepOverride } from "./pi/grep-tool.ts";
import { registerForgetTool } from "./pi/forget-tool.ts";
import { makeReplaceTool } from "./pi/replace-tool.ts";
import { makeWriteOverride } from "./pi/write-tool.ts";
import { createActionFusionExecutor } from "./pi/action-fusion.ts";
import { registerFusionCards, withMutationStatus } from "./pi/fusion-card.ts";

export default function (pi: ExtensionAPI) {
  const cwd = process.cwd();

  // Tools capture this snapshot at registration; a reload registers them again.
  const config = loadConfig(cwd);

  // `enabled: false` leaves the extension fully inert — pi's built-in
  // read/edit/grep/replace/write stay in place, as if this package were not installed.
  if (config.enabled) {
    const reportProgress = registerFusionCards(pi);
    const fusion = config.actionFusion
      ? createActionFusionExecutor(undefined, reportProgress)
      : undefined;
    const registerMutation = <TParams extends TSchema, TDetails>(
      tool: ToolDefinition<TParams, TDetails>,
    ) => pi.registerTool(fusion ? withMutationStatus(tool) : tool);
    registerMutation(makeWriteOverride(cwd, fusion));
    registerMutation(makeEditOverride(cwd, config, fusion));
    registerMutation(makeReplaceTool(cwd, config, fusion));

    pi.registerTool(makeReadOverride(cwd, config));
    pi.registerTool(makeGrepOverride(cwd, config));
    registerForgetTool(pi);
  }
}
