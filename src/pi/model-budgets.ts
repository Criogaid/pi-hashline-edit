/** Per-extension budgets. Tool preparation and execution share the same provider. */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { outputBudgetsFor, type OutputBudgetProvider } from "./budgets.ts";

/** Retain Pi's live context getter, including after session restore, without calculating on events. */
export function registerModelBudgets(pi: ExtensionAPI): OutputBudgetProvider {
  let context: ExtensionContext | undefined;
  const bind = (_event: unknown, ctx: ExtensionContext) => {
    context = ctx;
  };
  pi.on("session_start", bind);
  pi.on("model_select", bind);
  return () => outputBudgetsFor(context?.model?.contextWindow);
}
