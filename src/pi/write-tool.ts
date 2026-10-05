import { Type, type Static } from "typebox";
import type { AgentToolResult, AgentToolUpdateCallback } from "@earendil-works/pi-agent-core";
import {
  createWriteToolDefinition,
  type ExtensionToolContext,
  type Theme,
  type ToolRenderResultOptions,
} from "@earendil-works/pi-coding-agent";
import {
  ACTION_FUSION_GUIDELINES,
  withThenRunSchema,
  type ThenRunInput,
  type ActionFusionDetails,
} from "./action-fusion.ts";
import { commitFile, type CommitMode, type CommitResult } from "./file-commit.ts";
import { postProcessMutation } from "./mutation-result.ts";
import { executeMutation, type ActionFusionExecutor } from "./mutation-runner.ts";
import { MUTATION_TOOL_GUIDELINE } from "./tool-prompts.ts";
import { invalidArgument, throwIfCancelled } from "./error-text.ts";
import { unwritableTextReason } from "../core/text.ts";
import { renderToolError } from "./render.ts";

const writeSchema = Type.Object(
  {
    path: Type.String({ minLength: 1, description: "Path to the file (relative or absolute)" }),
    content: Type.String({
      description: "Complete file content, written exactly as supplied, including line endings.",
    }),
    mode: Type.Optional(
      Type.Union([
        Type.Literal("create", { description: "Fail if the target already exists" }),
        Type.Literal("overwrite", { description: "Fail if the target does not exist" }),
      ]),
    ),
  },
  { additionalProperties: false },
);

function createWriteSchema(actionFusion: boolean) {
  return withThenRunSchema(writeSchema, "write", actionFusion);
}
type WriteParams = Static<typeof writeSchema> & { then_run?: ThenRunInput };
type WriteDetails = CommitResult & { path: string; actionFusion?: ActionFusionDetails };
type WriteRenderContext = Parameters<
  NonNullable<ReturnType<typeof createWriteToolDefinition>["renderCall"]>
>[2];

export function makeWriteOverride(cwd: string, fusion?: ActionFusionExecutor) {
  const parameters = createWriteSchema(fusion !== undefined);
  const builtin = createWriteToolDefinition(cwd);
  return {
    name: "write" as const,
    label: "write",
    description:
      "Write a whole file exactly as supplied, including its line endings. By default, creates missing files and parent directories and overwrites existing files.",
    promptSnippet: "Write complete file content to a path",
    promptGuidelines: [MUTATION_TOOL_GUIDELINE, ...(fusion ? ACTION_FUSION_GUIDELINES : [])],
    parameters,
    /** Reject content that cannot be written as UTF-8 before Pi's schema validation; never rewrites. */
    prepareArguments(args: unknown): WriteParams {
      const content = (args as { content?: unknown } | null)?.content;
      const reason = typeof content === "string" ? unwritableTextReason(content) : undefined;
      if (reason) throw invalidArgument("content", reason);
      return args as WriteParams;
    },
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
          cwd,
          fusion,
          async run(mutationParams, { absolutePath, displayPath, signal }) {
            throwIfCancelled(signal, `before write; ${displayPath} was not changed.`);
            const result = await commitFile(absolutePath, mutationParams.content, {
              mode: mutationParams.mode as CommitMode | undefined,
              signal,
            });
            return {
              commit: result,
              result: postProcessMutation("write", result.publication, () => ({
                content: [
                  {
                    type: "text" as const,
                    text:
                      result.publication === "NOT_PUBLISHED"
                        ? `Wrote ${displayPath} (no net change).`
                        : `${result.created ? "Created" : "Wrote"} ${displayPath}.`,
                  },
                ],
                details: { path: displayPath, ...result },
              })),
            };
          },
        },
        { toolCallId, params, signal, onUpdate, ctx },
      );
    },
  };
}
