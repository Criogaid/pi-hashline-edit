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

import { isAbsolute, join } from "node:path";
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

export default async function (pi: ExtensionAPI) {
  // Pi runs exec in the extension loader's workspace, even before session_start.
  // Replay on reload needs tools and entry renderers registered before that event.
  // Ask the OS directly so a second Node runtime cannot rerun the host's preloads.
  const windows = process.platform === "win32";
  const result = windows
    ? await pi.exec(
        join(
          process.env.SystemRoot ?? "C:\\Windows",
          "System32/WindowsPowerShell/v1.0/powershell.exe",
        ),
        [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          "[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false); [Console]::Write([Environment]::CurrentDirectory)",
        ],
      )
    : await pi.exec("/bin/pwd", ["-P"]);
  const { stderr, code, killed, truncated } = result;
  const cwd = windows ? result.stdout : result.stdout.replace(/\n$/, "");
  if (code !== 0 || killed || truncated || !isAbsolute(cwd)) {
    throw new Error(`Unable to resolve the Pi workspace (exit ${code})`, {
      cause: stderr || undefined,
    });
  }

  // Tools capture this snapshot at registration; a reload registers them again.
  const config = loadConfig(cwd);

  // `enabled: false` leaves the extension fully inert — pi's built-in
  // read/grep/edit/write stay in place, as if this package were not installed.
  if (config.enabled) {
    const budgets = registerModelBudgets(pi);
    // Saved then_run cards render even when Action Fusion is off.
    const reportProgress = registerFusionCards(pi);
    const fusion = config.actionFusion ? createActionFusionExecutor(reportProgress) : undefined;
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
    const env = { cwd, config, budgets };
    const mutationEnv = { ...env, fusion };
    registerMutation(makeWriteOverride(mutationEnv));
    registerMutation(makeEditOverride(mutationEnv));
    registerMutation(makeReplaceTool(mutationEnv));

    register(makeReadOverride(env));
    register(makeGrepOverride(env));
  }
}
