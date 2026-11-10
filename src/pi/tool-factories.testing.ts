import { tmpdir } from "node:os";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "./config.ts";
import { outputBudgetsFor } from "./budgets.ts";
import { makeReadOverride as read } from "./read-tool.ts";
import { makeGrepOverride as grep } from "./grep-tool.ts";
import { makeEditOverride as edit } from "./edit-tool.ts";
import { makeReplaceTool as replace } from "./replace-tool.ts";
import { makeWriteOverride as write } from "./write-tool.ts";

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

export const makeReadOverride = (
  cwd: string,
  config: Parameters<typeof read>[1],
  budgets = defaultOutputBudgets,
) => read(cwd, config, budgets);
export const makeGrepOverride = (
  cwd: string,
  config: Parameters<typeof grep>[1],
  budgets = defaultOutputBudgets,
) => grep(cwd, config, budgets);
export const makeEditOverride = (
  cwd: string,
  config: Parameters<typeof edit>[1],
  fusion: Parameters<typeof edit>[2] = undefined,
  budgets = defaultOutputBudgets,
) => edit(cwd, config, fusion, budgets);
export const makeReplaceTool = (
  cwd: string,
  config: Parameters<typeof replace>[1],
  fusion: Parameters<typeof replace>[2] = undefined,
  budgets = defaultOutputBudgets,
) => replace(cwd, config, fusion, budgets);
export const makeWriteOverride = (
  cwd: string,
  fusion: Parameters<typeof write>[1] = undefined,
  budgets = defaultOutputBudgets,
) => write(cwd, fusion, budgets);
