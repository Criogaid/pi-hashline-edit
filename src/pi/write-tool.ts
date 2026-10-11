import { Type, type Static } from "typebox";
import type { AgentToolResult, AgentToolUpdateCallback } from "@earendil-works/pi-agent-core";
import { Text } from "@earendil-works/pi-tui";
import {
  createWriteToolDefinition,
  type ExtensionToolContext,
  type Theme,
  type ToolRenderResultOptions,
} from "@earendil-works/pi-coding-agent";
import {
  ACTION_FUSION_GUIDELINES,
  withThenRunDescription,
  withThenRunSchema,
  type ThenRunInput,
  type ActionFusionDetails,
} from "./action-fusion.ts";
import { commitFile, type CommitResult } from "./file-commit.ts";
import { executeMutation, type ActionFusionExecutor } from "./mutation-runner.ts";
import { throwIfCancelled } from "./error-text.ts";
import { createArgumentPreparer } from "./argument-validation.ts";
import { defaultOutputBudgets, type OutputBudgetProvider } from "./budgets.ts";
import { unwritableTextError } from "../core/text.ts";
import { reportLines, renderToolError } from "./render.ts";
import type { ReportDetails } from "./report.ts";

const writeSchema = Type.Object(
  {
    path: Type.String({ minLength: 1, description: "Path to the file (relative or absolute)" }),
    content: Type.String({
      description: "Complete file content, written exactly as supplied, including line endings.",
    }),
    mode: Type.Union([
      Type.Literal("create", { description: "Fail if the target already exists." }),
      Type.Literal("overwrite", { description: "Fail if the target does not exist." }),
    ]),
  },
  { additionalProperties: false },
);

function createWriteSchema(actionFusion: boolean) {
  return withThenRunSchema(writeSchema, "write", actionFusion);
}
type WriteParams = Static<typeof writeSchema> & { then_run?: ThenRunInput };
type WriteDetails = CommitResult & {
  path: string;
  actionFusion?: ActionFusionDetails;
} & Partial<ReportDetails>;
/** The write card's call line shows the content; the command card owns then_run. */
const WRITE_CARD_SHOWN = new Set(["publication", "created", "then_run", "progressError"]);
type WriteRenderContext = Parameters<
  NonNullable<ReturnType<typeof createWriteToolDefinition>["renderCall"]>
>[2];

export function makeWriteOverride(
  cwd: string,
  fusion?: ActionFusionExecutor,
  budgets: OutputBudgetProvider = defaultOutputBudgets,
) {
  const parameters = createWriteSchema(fusion !== undefined);
  const builtin = createWriteToolDefinition(cwd);
  return {
    name: "write" as const,
    label: "write",
    description: withThenRunDescription(
      "Write a whole file exactly as supplied, including its line endings. Do not use write for partial changes to an existing file; use edit or replace. Choose create for a new file or overwrite for an existing file. Creates missing parent directories.",
      fusion !== undefined,
    ),
    promptSnippet: "Write complete file content to a path",
    promptGuidelines: [...(fusion ? ACTION_FUSION_GUIDELINES : [])],
    parameters,
    prepareArguments: createArgumentPreparer(
      "write",
      parameters,
      (args, report) => {
        const content = (args as { content?: unknown } | null)?.content;
        const unwritable = typeof content === "string" ? unwritableTextError(content) : undefined;
        if (unwritable) report("content", unwritable.message);
      },
      budgets,
    ),
    renderShell: "default" as const,
    renderCall(args: WriteParams, theme: Theme, context: WriteRenderContext) {
      return builtin.renderCall!(args, theme, context);
    },
    renderResult(
      result: AgentToolResult<WriteDetails>,
      options: ToolRenderResultOptions,
      theme: Theme,
      context: WriteRenderContext,
    ) {
      if (context.isError) return renderToolError(result, theme, options.expanded);
      const report = result.details?.report;
      const facts = report ? reportLines(report, theme, options.expanded, WRITE_CARD_SHOWN) : [];
      if (facts.length) return new Text(facts.join("\n"), 0, 0);
      return builtin.renderResult!({ ...result, details: undefined }, options, theme, context);
    },
    async execute(
      toolCallId: string,
      params: WriteParams,
      signal: AbortSignal | undefined,
      onUpdate: AgentToolUpdateCallback<WriteDetails> | undefined,
      ctx: ExtensionToolContext,
    ) {
      return executeMutation<Omit<WriteParams, "then_run">, WriteDetails>(
        {
          tool: "write",
          cwd,
          fusion,
          budgets,
          async run(mutationParams, { absolutePath, displayPath, signal }) {
            throwIfCancelled(signal);
            const commit = await commitFile(absolutePath, mutationParams.content, {
              mode: mutationParams.mode,
              signal,
            });
            return {
              commit,
              details: { path: displayPath, ...commit },
              facts: commit.created ? { created: true } : {},
            };
          },
        },
        { toolCallId, params, signal, onUpdate, ctx },
      );
    },
  };
}
