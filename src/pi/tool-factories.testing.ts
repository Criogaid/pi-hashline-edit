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
import { runAlone, type MutationToolEnvironment } from "./mutation-runner.ts";
import type { MutationScheduler } from "./mutation-result.ts";

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
function mutationEnvironment(
  cwd: string,
  config: HashlineEditConfig,
  budgets: OutputBudgetProvider,
  schedule: MutationScheduler,
): MutationToolEnvironment {
  return {
    ...toolEnvironment(cwd, { ...config, actionFusion: schedule !== runAlone }, budgets),
    schedule,
  };
}

export const makeEditOverride = (
  cwd: string,
  config: HashlineEditConfig,
  schedule = runAlone,
  budgets = defaultOutputBudgets,
) => edit(mutationEnvironment(cwd, config, budgets, schedule));
export const makeReplaceTool = (
  cwd: string,
  config: HashlineEditConfig,
  schedule = runAlone,
  budgets = defaultOutputBudgets,
) => replace(mutationEnvironment(cwd, config, budgets, schedule));
export const makeWriteOverride = (
  cwd: string,
  schedule = runAlone,
  budgets = defaultOutputBudgets,
) => write(mutationEnvironment(cwd, DEFAULT_CONFIG, budgets, schedule));
