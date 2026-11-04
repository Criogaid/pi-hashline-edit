/** Per-extension budgets. Tool preparation and execution share the same provider. */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { outputBudgetsFor, type OutputBudgetProvider } from "./budgets.ts";

/** Retain Pi's context once per session: its model getter stays live, so no event recalculates. */
export function registerModelBudgets(pi: ExtensionAPI): OutputBudgetProvider {
  let context: ExtensionContext | undefined;
  pi.on("session_start", (_event, ctx) => {
    context = ctx;
  });
  return () => outputBudgetsFor(context?.model?.contextWindow);
}
