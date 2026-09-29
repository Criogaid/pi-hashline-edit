import { Type, type Static } from "typebox";
import type { AgentToolResult, AgentToolUpdateCallback } from "@earendil-works/pi-agent-core";
import {
  createWriteToolDefinition,
  withFileMutationQueue,
  type ExtensionContext,
  type Theme,
  type ToolRenderResultOptions,
} from "@earendil-works/pi-coding-agent";
import {
  ACTION_FUSION_GUIDELINES,
  createActionFusionExecutor,
  createThenRunSchema,
  type ThenRunInput,
  type ActionFusionDetails,
} from "./action-fusion.ts";
import { commitFile, type CommitMode, type CommitResult } from "./file-commit.ts";
import { postProcessMutation } from "./mutation-result.ts";
import { canonicalPath } from "./path.ts";

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
  return actionFusion
    ? Type.Object(
        {
          ...writeSchema.properties,
          then_run: createThenRunSchema(
            "Command to run after write succeeds; failure does not roll back the write.",
          ),
        },
        { additionalProperties: false },
      )
    : writeSchema;
}
type WriteParams = Static<typeof writeSchema> & { then_run?: ThenRunInput };
type WriteDetails = CommitResult & { path: string; actionFusion?: ActionFusionDetails };
type WriteRenderContext = Parameters<
  NonNullable<ReturnType<typeof createWriteToolDefinition>["renderCall"]>
>[2];

export function makeWriteOverride(
  cwd: string,
  fusion?: ReturnType<typeof createActionFusionExecutor>,
) {
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
      if ("expectedRevision" in params)
        throw new Error("expectedRevision is not supported by write");
      const { then_run, ...mutationParams } = params;
      if (!fusion && then_run !== undefined)
        throw new Error("then_run is unavailable because hashlineEdit.actionFusion is disabled");
      const unsupported = Object.keys(params).filter(
        (key) => !Object.hasOwn(parameters.properties, key),
      );
      if (unsupported.length)
        throw new Error(`write parameters not supported: ${unsupported.join(", ")}`);
      const absolutePath = canonicalPath(cwd, mutationParams.path);
      const mutate = (): Promise<AgentToolResult<WriteDetails>> =>
        withFileMutationQueue(absolutePath, async () => {
          signal?.throwIfAborted();
          const result = await commitFile(absolutePath, mutationParams.content, {
            mode: mutationParams.mode as CommitMode | undefined,
            signal,
          });
          return postProcessMutation("write", result.publication, () => ({
            content: [
              {
                type: "text" as const,
                text:
                  result.publication === "NOT_PUBLISHED"
                    ? `Wrote ${mutationParams.path} (no net change).`
                    : `${result.created ? "Created" : "Wrote"} ${mutationParams.path}.`,
              },
            ],
            details: { path: mutationParams.path, ...result },
          }));
        });
      if (!fusion) return mutate();
      return fusion({ toolCallId, absolutePath, thenRun: then_run, mutate, signal, ctx, onUpdate });
    },
  };
}
