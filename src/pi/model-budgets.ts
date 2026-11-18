/** Per-extension budgets. Tool preparation and execution share the same provider. */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { outputBudgetsFor, type OutputBudgetProvider } from "./budgets.ts";

/** Retain Pi's live model getter; the headless SDK can reload without emitting session_start. */
export function registerModelBudgets(pi: ExtensionAPI): OutputBudgetProvider {
  let context: ExtensionContext | undefined;
  const capture = (_event: unknown, ctx: ExtensionContext) => {
    context ??= ctx;
  };
  pi.on("session_start", capture);
  // Pi emits this before argument preparation, including for nested calls.
  pi.on("tool_execution_start", capture);
  return () => outputBudgetsFor(context?.model?.contextWindow);
}
