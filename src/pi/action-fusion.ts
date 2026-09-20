import { realpath } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import type { AgentToolResult, AgentToolUpdateCallback } from "@earendil-works/pi-agent-core";
import { createBashToolDefinition, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { fileRevision, FileMutationError, type PublicationStatus } from "./file-commit.ts";

export const THEN_RUN_SUCCEEDED = "[then_run:succeeded]";
export const THEN_RUN_FAILED = "[then_run:failed]";
export const THEN_RUN_SKIPPED = "[then_run:skipped]";
export const THEN_RUN_STALE = "[then_run:stale]";

export const ACTION_FUSION_GUIDELINES = [
	"Before each file mutation, identify its next command. If that command is known, authorized, and ready once the mutation succeeds, you MUST include it in then_run instead of making a separate command call (for example, write a script and execute it, or finish edits and run a typecheck).",
	"When several edits are prerequisites, attach then_run to the last one. Separate the command only when its choice or arguments depend on inspecting the mutation result, or a required approval or user reload is still pending.",
	"Check the command outcome before claiming validation passed.",
];

export interface ThenRunInput {
	command: string;
	timeout?: number;
}

export type CommandStatus = "not_requested" | "skipped" | "succeeded" | "failed" | "timeout" | "cancelled";
export type Freshness = "unchanged" | "changed" | "missing" | "unknown";
export interface ActionFusionDetails {
	publication: PublicationStatus;
	command: CommandStatus;
	freshness: Freshness;
}

export interface ActionFusionProgress extends Omit<ActionFusionDetails, "command"> {
	toolCallId: string;
	path: string;
	commandText: string;
	command: Exclude<CommandStatus, "not_requested"> | "waiting" | "running";
	output: string;
}

type ProgressReporter = (progress: ActionFusionProgress, ctx: ExtensionContext) => void;

export function createThenRunSchema(description: string) {
	return Type.Optional(Type.Object({
		command: Type.String({ minLength: 1, description: "Bash command to run" }),
		timeout: Type.Optional(Type.Number({ exclusiveMinimum: 0, description: "Timeout in seconds (optional, no default timeout)" })),
	}, { description }));
}

type CommandRunner = (toolCallId: string, input: ThenRunInput, signal: AbortSignal | undefined, ctx: ExtensionContext, onUpdate?: AgentToolUpdateCallback<unknown>) => Promise<string>;

type MutationResult<TDetails> = AgentToolResult<TDetails>;
type MutationFinalizer<TDetails> = (result: MutationResult<TDetails>, publishAnchors: boolean) => MutationResult<TDetails>;

function staleAnchorNotice<TDetails>(result: MutationResult<TDetails>): string {
	const revision = (result.details as { revision?: unknown } | undefined)?.revision;
	return [
		`${THEN_RUN_STALE} Target freshness was not confirmed unchanged after then_run.`,
		"Pre-command anchors are omitted. Re-read before further edits.",
		...(typeof revision === "string" ? ["The mutation revision may not describe the final file."] : []),
	].join("\n");
}

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

async function readFreshness(path: string, baseline: string): Promise<Freshness> {
	try {
		return (await fileRevision(path)) === baseline ? "unchanged" : "changed";
	} catch (error) {
		if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return "missing";
		return "unknown";
	}
}

async function assertUnchangedBeforeCommand(path: string, baseline: string): Promise<void> {
	try {
		const before = await fileRevision(path);
		await new Promise<void>((resolve) => setImmediate(resolve));
		const after = await fileRevision(path);
		if (before !== baseline || after !== baseline) {
			throw new Error("target content changed after the fused mutation");
		}
	} catch (error) {
		throw new Error(`${THEN_RUN_SKIPPED} ${errorText(error)}; the command was not run.`);
	}
}

export class ActionFusionError extends Error {
	readonly publication: PublicationStatus;
	readonly command: CommandStatus;
	readonly freshness: Freshness;

	constructor(message: string, state: { publication: PublicationStatus; command: CommandStatus; freshness: Freshness }, options?: { cause?: unknown }) {
		const fileState = state.publication === "PUBLISHED" ? "File changes are saved."
			: state.publication === "NOT_PUBLISHED" ? "No file changes were published." : "File state is uncertain; read before retrying.";
		const nextStep = state.publication === "PUBLISHED" && state.freshness !== "unchanged"
			? " Re-read the file before further edits." : "";
		super(`${message} ${state.command === "skipped" || state.command === "cancelled" ? THEN_RUN_SKIPPED : state.command === "succeeded" ? THEN_RUN_SUCCEEDED : THEN_RUN_FAILED}\n${fileState} Command ${state.command}.${nextStep}`, options);
		// Pi exposes error.message to the model, but does not serialize Error.cause.
		if (options?.cause !== undefined) this.message += `\n${errorText(options.cause)}`;
		this.name = "ActionFusionError";
		this.publication = state.publication;
		this.command = state.command;
		this.freshness = state.freshness;
	}
}

function mutationPublication<TDetails>(result: MutationResult<TDetails>): PublicationStatus {
	const details = result.details as { publication?: PublicationStatus } | undefined;
	return details?.publication ?? "PUBLISHED";
}

function commandStatus(error: unknown, signal: AbortSignal | undefined): CommandStatus {
	if (signal?.aborted) return "cancelled";
	return /timeout|timed out/i.test(errorText(error)) ? "timeout" : "failed";
}

function validateThenRun(input: ThenRunInput): void {
	if (!input.command.trim()) throw new Error("then_run command must not be empty");
	if (input.timeout !== undefined && (!Number.isFinite(input.timeout) || input.timeout <= 0)) {
		throw new Error("then_run timeout must be a finite positive number of seconds");
	}
}

async function defaultCommandRunner(toolCallId: string, input: ThenRunInput, signal: AbortSignal | undefined, ctx: ExtensionContext, onUpdate?: AgentToolUpdateCallback<unknown>): Promise<string> {
	const bash = createBashToolDefinition(ctx.cwd);
	const result = await bash.execute(`${toolCallId}:then_run`, input, signal, onUpdate, ctx);
	return result.content.filter((block) => block.type === "text").map((block) => block.text).join("\n");
}

async function canonicalQueueKey(path: string): Promise<string> {
	const resolved = resolve(path);
	let current = resolved;
	const missing: string[] = [];
	while (true) {
		try { return resolve(await realpath(current), ...missing); }
		catch (error) {
			if (!(typeof error === "object" && error !== null && "code" in error && (error.code === "ENOENT" || error.code === "ENOTDIR"))) throw error;
			const parent = dirname(current);
			if (parent === current) return resolved;
			missing.unshift(basename(current));
			current = parent;
		}
	}
}

export function createActionFusionExecutor(commandRunner: CommandRunner = defaultCommandRunner, onProgress?: ProgressReporter) {
	const queueTails = new Map<string, Promise<void>>();

	async function withQueue<T>(path: string, work: () => Promise<T>): Promise<T> {
		const key = await canonicalQueueKey(path);
		const previous = queueTails.get(key) ?? Promise.resolve();
		let release!: () => void;
		const owned = new Promise<void>((resolve) => { release = resolve; });
		const tail = previous.then(() => owned);
		queueTails.set(key, tail);
		await previous;
		try {
			return await work();
		} finally {
			release();
			if (queueTails.get(key) === tail) queueTails.delete(key);
		}
	}

	return async function execute<TDetails>({
		toolCallId,
		absolutePath,
		thenRun,
		mutate,
		signal,
		ctx,
		onUpdate,
		finalizeMutation,
	}: {
		toolCallId: string;
		absolutePath: string;
		thenRun: ThenRunInput | undefined;
		mutate: () => Promise<MutationResult<TDetails>>;
		signal: AbortSignal | undefined;
		ctx: ExtensionContext;
		onUpdate?: AgentToolUpdateCallback<TDetails>;
		finalizeMutation?: MutationFinalizer<TDetails>;
	}): Promise<MutationResult<TDetails>> {
		if (thenRun !== undefined) validateThenRun(thenRun);
		let completedMutation: MutationResult<TDetails> | undefined;
		const report = (command: ActionFusionProgress["command"], publication: PublicationStatus, freshness: Freshness, output = "") => {
			if (!thenRun) return;
			const progress: ActionFusionProgress = { toolCallId, path: absolutePath, commandText: thenRun.command, command, publication, freshness, output };
			onProgress?.(progress, ctx);
			onUpdate?.({
				content: [...(completedMutation?.content ?? []), { type: "text", text: `then_run ${command}: ${thenRun.command}\n${output}` }],
				details: { ...(completedMutation?.details as object ?? {}), actionFusion: progress },
			} as MutationResult<TDetails>);
		};
		report("waiting", "NOT_PUBLISHED", "unknown");
		return withQueue(absolutePath, async () => {
			try { signal?.throwIfAborted(); } catch (error) {
				if (thenRun !== undefined) throw new ActionFusionError("mutation was cancelled before it started; the command was not run", { publication: "NOT_PUBLISHED", command: "cancelled", freshness: "unknown" }, { cause: error });
				throw error;
			}
			let mutationResult: MutationResult<TDetails>;
			try {
				mutationResult = await mutate();
				completedMutation = mutationResult;
			} catch (error) {
				const publication = error instanceof FileMutationError ? error.publication : "NOT_PUBLISHED";
				if (thenRun !== undefined) {
					throw new ActionFusionError(`mutation ${error instanceof FileMutationError ? error.stage : "failed"}; the command was not run`, { publication, command: "skipped", freshness: "unknown" }, { cause: error });
				}
				throw error;
			}

			const publication = mutationPublication(mutationResult);
			if (thenRun === undefined) {
				const finalized = finalizeMutation?.(mutationResult, true) ?? mutationResult;
				return {
					...finalized,
					details: { ...(finalized.details as object ?? {}), actionFusion: { publication, command: "not_requested", freshness: "unknown" } satisfies ActionFusionDetails },
				} as MutationResult<TDetails>;
			}

			let baseline: string | undefined;
			try {
				baseline = await fileRevision(absolutePath);
				signal?.throwIfAborted();
				await assertUnchangedBeforeCommand(absolutePath, baseline);
				signal?.throwIfAborted();
			} catch (error) {
				const freshness = baseline ? await readFreshness(absolutePath, baseline) : "unknown";
				throw new ActionFusionError("mutation completed; the command was not run", { publication, command: signal?.aborted ? "cancelled" : "skipped", freshness }, { cause: error });
			}

			report("running", publication, "unchanged");
			let output: string;
			let commandError: unknown;
			try {
				output = await commandRunner(toolCallId, thenRun, signal, ctx, (partial) => {
					const text = partial.content.filter((block) => block.type === "text").map((block) => block.text).join("\n");
					report("running", publication, "unknown", text);
				});
			} catch (error) {
				commandError = error;
				output = "";
			}
			const freshness = baseline ? await readFreshness(absolutePath, baseline) : "unknown";
			if (commandError !== undefined) {
				throw new ActionFusionError("mutation completed; then_run did not complete successfully", { publication, command: commandStatus(commandError, signal), freshness }, { cause: commandError });
			}

			const actionFusion: ActionFusionDetails = { publication, command: "succeeded", freshness };
			report("succeeded", publication, freshness, output);
			const finalized = finalizeMutation?.(mutationResult, freshness === "unchanged") ?? mutationResult;
			const commandText = freshness === "unchanged"
				? (output ? `${THEN_RUN_SUCCEEDED}\n${output}` : THEN_RUN_SUCCEEDED)
				: `${THEN_RUN_SUCCEEDED}\n${
					finalizeMutation
						? staleAnchorNotice(finalized)
						: `${THEN_RUN_STALE} Re-read the file before further edits; previous anchors may no longer match.`
				}${output ? `\n${output}` : ""}`;
			return {
				...finalized,
				details: { ...(finalized.details as object ?? {}), actionFusion },
				content: [...finalized.content, { type: "text", text: commandText }],
			} as MutationResult<TDetails>;
		}).catch((error: unknown) => {
			report(error instanceof ActionFusionError ? error.command as ActionFusionProgress["command"] : "skipped",
				error instanceof ActionFusionError ? error.publication : "NOT_PUBLISHED",
				error instanceof ActionFusionError ? error.freshness : "unknown", errorText(error));
			// A completed mutation remains successful; command failure belongs to its own card.
			if (completedMutation && error instanceof ActionFusionError) {
				const finalized = finalizeMutation?.(completedMutation, error.freshness === "unchanged") ?? completedMutation;
				const anchorNotice = finalizeMutation && error.freshness !== "unchanged" ? `\n${staleAnchorNotice(finalized)}` : "";
				return {
					...finalized,
					details: { ...(finalized.details as object ?? {}), actionFusion: { publication: error.publication, command: error.command, freshness: error.freshness } satisfies ActionFusionDetails },
					content: [...finalized.content, { type: "text", text: `${error.message}${anchorNotice}` }],
				} as MutationResult<TDetails>;
			}
			throw error;
		});
	};
}
