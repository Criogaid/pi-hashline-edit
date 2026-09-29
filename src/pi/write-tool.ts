import { Type, type Static } from "typebox";
import type { AgentToolResult, AgentToolUpdateCallback } from "@earendil-works/pi-agent-core";
import {
  createWriteToolDefinition,
  type ExtensionContext,
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
import { throwIfCancelled } from "./error-text.ts";

const writeSchema = Type.Object(
  {
    path: Type.String({ minLength: 1, description: "Path to the file to write" }),
    content: Type.String({
      description:
        "Complete file content, including the exact desired line endings. Source-code escape sequences remain literal text.",
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
  return withThenRunSchema(
    writeSchema,
    "Command to run after write succeeds; failure does not roll back the write.",
    actionFusion,
  );
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
      "Write complete file content exactly as supplied, including LF/CRLF choices. Use for intentional whole-file line-ending conversion. By default, creates missing files (including parent directories) and overwrites existing files.",
    promptSnippet: "Write complete file content to a path",
    promptGuidelines: [
      "Use write for creating new files or whole-file overwrites; for targeted changes, prefer edit or replace to preserve surrounding content.",
      ...(fusion ? ACTION_FUSION_GUIDELINES : []),
    ],
    parameters,
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
      return builtin.renderResult!({ ...result, details: undefined }, options, theme, context);
    },
    async execute(
      toolCallId: string,
      params: WriteParams,
      signal: AbortSignal | undefined,
      onUpdate: AgentToolUpdateCallback<WriteDetails> | undefined,
      ctx: ExtensionContext,
    ) {
      return executeMutation<Omit<WriteParams, "then_run">, WriteDetails>(
        {
          cwd,
          fusion,
          // Write results carry no anchors; stale revisions are reported by then_run.
          reportsAnchors: false,
          async run(mutationParams, { absolutePath, displayPath, signal }) {
            throwIfCancelled(signal, `before write; ${displayPath} was not changed.`);
            const result = await commitFile(absolutePath, mutationParams.content, {
              mode: mutationParams.mode as CommitMode | undefined,
              signal,
            });
            return {
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
