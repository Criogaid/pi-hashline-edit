import { Type, type Static } from "typebox";
import { createWriteToolDefinition, withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { ACTION_FUSION_GUIDELINES, createActionFusionExecutor, createThenRunSchema, type ThenRunInput } from "./action-fusion.ts";
import { commitFile, type CommitMode } from "./file-commit.ts";
import { postProcessMutation } from "./mutation-result.ts";
import { canonicalPath } from "./path.ts";

function createWriteSchema(actionFusion: boolean) {
	return Type.Object({
		path: Type.String({ description: "Path to the file to write" }),
		content: Type.String({ description: "Complete file content, including the exact desired line endings. Source-code escape sequences remain literal text." }),
		mode: Type.Optional(Type.Union([
			Type.Literal("create", { description: "Fail if the target already exists" }),
			Type.Literal("overwrite", { description: "Fail if the target does not exist" }),
		])),
		expectedRevision: Type.Optional(Type.String({ description: "Expected SHA-256 revision of an existing target" })),
		...(actionFusion ? { then_run: createThenRunSchema("Command to run after write succeeds; failure does not roll back the write.") } : {}),
	});
}

const writeSchema = createWriteSchema(false);
type WriteParams = Omit<Static<typeof writeSchema>, "then_run"> & { then_run?: ThenRunInput };

export function makeWriteOverride(cwd: string, fusion?: ReturnType<typeof createActionFusionExecutor>): any {
	const parameters = createWriteSchema(fusion !== undefined);
	const builtin = createWriteToolDefinition(cwd);
	return {
		name: "write" as const,
		label: "write",
		description: "Write complete file content exactly as supplied, including LF/CRLF choices. Use for intentional whole-file line-ending conversion. By default, creates missing files and overwrites existing files.",
		promptSnippet: "Write complete file content to a path",
		promptGuidelines: fusion ? ACTION_FUSION_GUIDELINES : [],
		parameters,
		renderShell: "default" as const,
		renderCall: builtin.renderCall,
		renderResult: builtin.renderResult,
		async execute(toolCallId: string, params: WriteParams, signal: AbortSignal | undefined, onUpdate: any, ctx: any) {
			const { then_run, ...mutationParams } = params;
			if (!fusion && then_run !== undefined) throw new Error("then_run is unavailable because hashlineEdit.actionFusion is disabled");
			const absolutePath = canonicalPath(cwd, mutationParams.path);
			const mutate = () => withFileMutationQueue(absolutePath, async () => {
				signal?.throwIfAborted();
				const result = await commitFile(absolutePath, mutationParams.content, {
					mode: mutationParams.mode as CommitMode | undefined,
					expectedRevision: mutationParams.expectedRevision,
					signal,
				});
				return postProcessMutation("write", result.publication, () => ({
					content: [{ type: "text" as const, text: result.publication === "NOT_PUBLISHED"
						? `Wrote ${mutationParams.path} (no net change).`
						: `${result.created ? "Created" : "Wrote"} ${mutationParams.path}.` }],
					details: { path: mutationParams.path, ...result },
				}));
			});
			if (!fusion) return mutate();
			return fusion({ toolCallId, absolutePath, thenRun: then_run, mutate, signal, ctx, onUpdate });
		},
	};
}
