import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadConfig, type HashlineEditConfig } from "./config.ts";
import { outputBudgetsFor, type OutputBudgetProvider } from "./budgets.ts";
import { makeReadOverride as read } from "./read-tool.ts";
import { makeGrepOverride as grep } from "./grep-tool.ts";
import { makeEditOverride as edit } from "./edit-tool.ts";
import { makeReplaceTool as replace } from "./replace-tool.ts";
import { makeWriteOverride as write } from "./write-tool.ts";
import type { MutationToolEnvironment } from "./mutation-runner.ts";

// The runner isolates global settings; create an empty project root for schema defaults.
const configRoot = mkdtempSync(join(tmpdir(), "hashline-default-config-"));
export const DEFAULT_CONFIG = (() => {
  try {
    return loadConfig(configRoot);
  } finally {
    rmSync(configRoot, { recursive: true, force: true });
  }
})();
export const DEFAULT_OUTPUT_BUDGETS = outputBudgetsFor(undefined);
export const defaultOutputBudgets = () => outputBudgetsFor(undefined);

function toolEnvironment(
  cwd: string,
  config: HashlineEditConfig,
  budgets: OutputBudgetProvider,
): { cwd: string; config: HashlineEditConfig; budgets: OutputBudgetProvider } {
  return { cwd, config, budgets };
}

export const makeReadOverride = (
  cwd: string,
  config: HashlineEditConfig,
  budgets = defaultOutputBudgets,
) => read(toolEnvironment(cwd, config, budgets));
export const makeGrepOverride = (
  cwd: string,
  config: HashlineEditConfig,
  budgets = defaultOutputBudgets,
) => grep(toolEnvironment(cwd, config, budgets));
export const makeEditOverride = (
  cwd: string,
  config: HashlineEditConfig,
  fusion: MutationToolEnvironment["fusion"] = undefined,
  budgets = defaultOutputBudgets,
) => edit({ ...toolEnvironment(cwd, config, budgets), fusion });
export const makeReplaceTool = (
  cwd: string,
  config: HashlineEditConfig,
  fusion: MutationToolEnvironment["fusion"] = undefined,
  budgets = defaultOutputBudgets,
) => replace({ ...toolEnvironment(cwd, config, budgets), fusion });
export const makeWriteOverride = (
  cwd: string,
  fusion: MutationToolEnvironment["fusion"] = undefined,
  budgets = defaultOutputBudgets,
) => write({ ...toolEnvironment(cwd, DEFAULT_CONFIG, budgets), fusion });
