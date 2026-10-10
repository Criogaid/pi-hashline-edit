/** Per-extension lazy budgets. Tool preparation and execution share the same provider. */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { outputBudgetsFor, type OutputBudgetProvider, type OutputBudgets } from "./budgets.ts";

type BudgetModel = Pick<
  NonNullable<ExtensionContext["model"]>,
  "provider" | "id" | "contextWindow"
>;

/** Reuse the snapshot until selection or its declared capacity changes. No provider request is made. */
export function createOutputBudgetProvider(
  readModel: () => BudgetModel | undefined,
): OutputBudgetProvider {
  let provider: string | undefined;
  let id: string | undefined;
  let contextWindow: number | undefined;
  let cached: OutputBudgets | undefined;
  return () => {
    const model = readModel();
    if (
      cached === undefined ||
      provider !== model?.provider ||
      id !== model?.id ||
      !Object.is(contextWindow, model?.contextWindow)
    ) {
      provider = model?.provider;
      id = model?.id;
      contextWindow = model?.contextWindow;
      cached = outputBudgetsFor(contextWindow);
    }
    return cached;
  };
}

/** Retain Pi's live context getter, including after session restore, without calculating on events. */
export function registerModelBudgets(pi: ExtensionAPI): OutputBudgetProvider {
  let context: ExtensionContext | undefined;
  const bind = (_event: unknown, ctx: ExtensionContext) => {
    context = ctx;
  };
  pi.on("session_start", bind);
  pi.on("model_select", bind);
  return createOutputBudgetProvider(() => context?.model);
}
