import { Type, type Static } from "typebox";
import { Text } from "@earendil-works/pi-tui";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { getState } from "./state.ts";
import { createActionFusionExecutor, createThenRunSchema, type ThenRunInput } from "./action-fusion.ts";
import { commitFile, FileMutationError, type CommitMode } from "./file-commit.ts";
import { canonicalPath } from "./read-tool.ts";
import { hashFileLines, splitLines } from "../core/index.ts";

function createWriteSchema(actionFusion: boolean) {
	return Type.Object({
		path: Type.String({ description: "Path to the file to write" }),
		content: Type.String({ description: "Complete file content" }),
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

function formatAnchors(content: string, hashLen: number): string {
	const lines = splitLines(content);
	const hashes = hashFileLines(lines, hashLen);
	const shown = lines.slice(0, 40).map((line, index) => `${index + 1}#${hashes[index]}│${line}`);
	const suffix = lines.length > shown.length ? `\n… (${lines.length - shown.length} more; read again for full anchors)` : "";
	return shown.length ? `\nFresh anchors:\n${shown.join("\n")}${suffix}` : "";
}

export function makeWriteTool(cwd: string, fusion?: ReturnType<typeof createActionFusionExecutor>): any {
	const parameters = createWriteSchema(fusion !== undefined);
	return {
		name: "write" as const,
		label: "write",
		description: "Write complete file content. By default, creates missing files and overwrites existing files.",
		promptSnippet: "Write complete file content to a path",
		promptGuidelines: [
			"Pass path and complete content.",
			"Use mode=create to refuse overwriting an existing file.",
			"Use expectedRevision to protect an overwrite against an unexpected current file revision.",
		],
		parameters,
		renderShell: "default" as const,
		renderCall(args: WriteParams, theme: any, context: any) {
			const text = (context?.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			text.setText(theme.fg("toolTitle", theme.bold("write ")) + theme.fg("accent", args.path));
			return text;
		},
		renderResult(result: any, { isPartial }: any, theme: any) {
			if (isPartial && result.details?.actionFusion?.publication !== "PUBLISHED") return new Text(theme.fg("warning", "Writing…"), 0, 0);
			const summary = result.content?.[0]?.type === "text" ? result.content[0].text : "Wrote file";
			const fusionOutput = result.content?.slice(1).filter((block: any) => block.type === "text").map((block: any) => block.text).join("\n");
			return new Text(theme.fg("success", fusionOutput ? `${summary}\n${fusionOutput}` : summary), 0, 0);
		},
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
				try {
					return {
						content: [{ type: "text" as const, text: `${result.created ? "Created" : "Wrote"} ${mutationParams.path}.\nRevision: ${result.revision}${formatAnchors(mutationParams.content, getState().config.hashLen)}` }],
						details: { path: mutationParams.path, revision: result.revision, created: result.created, publication: result.publication },
					};
				} catch (error) {
					throw new FileMutationError("post_process", "PUBLISHED", `file was published but write result generation failed: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
				}
			});
			if (!fusion) return mutate();
			return fusion({ toolCallId, absolutePath, thenRun: then_run, mutate, signal, ctx, onUpdate });
		},
	};
}
