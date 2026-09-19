import { createHash } from "node:crypto";
import { realpath, readFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { createBashToolDefinition, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { FileMutationError, type PublicationStatus } from "./file-commit.ts";

export const THEN_RUN_SUCCEEDED = "[then_run:succeeded]";
export const THEN_RUN_FAILED = "[then_run:failed]";
export const THEN_RUN_SKIPPED = "[then_run:skipped]";
export const THEN_RUN_STALE = "[then_run:stale]";

export interface ThenRunInput {
	command: string;
	timeout?: number;
}

export type ActionFusionAuthorizer = (input: { toolName: "edit" | "replace" | "write"; absolutePath: string; cwd: string; thenRun: ThenRunInput }) => void | Promise<void>;

export type CommandStatus = "not_requested" | "skipped" | "succeeded" | "failed" | "timeout" | "cancelled";
export type Freshness = "unchanged" | "changed" | "missing" | "unknown";
export interface ActionFusionDetails {
	publication: PublicationStatus;
	command: CommandStatus;
	freshness: Freshness;
}

export function createThenRunSchema(description: string) {
	return Type.Optional(Type.Object({
		command: Type.String({ minLength: 1, description: "Bash command to run" }),
		timeout: Type.Optional(Type.Number({ exclusiveMinimum: 0, description: "Timeout in seconds (optional, no default timeout)" })),
	}, { description }));
}

type CommandRunner = (toolCallId: string, input: ThenRunInput, signal: AbortSignal | undefined, ctx: ExtensionContext) => Promise<string>;

type MutationResult<TDetails> = AgentToolResult<TDetails>;

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

async function sha256(path: string): Promise<string> {
	return createHash("sha256").update(await readFile(path)).digest("hex");
}

async function readFreshness(path: string, baseline: string): Promise<Freshness> {
	try {
		return (await sha256(path)) === baseline ? "unchanged" : "changed";
	} catch (error) {
		if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return "missing";
		return "unknown";
	}
}

async function assertUnchangedBeforeCommand(path: string, baseline: string): Promise<void> {
	try {
		const before = await sha256(path);
		await new Promise<void>((resolve) => setImmediate(resolve));
		const after = await sha256(path);
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
		super(`${message} ${state.command === "skipped" || state.command === "cancelled" ? THEN_RUN_SKIPPED : state.command === "succeeded" ? THEN_RUN_SUCCEEDED : THEN_RUN_FAILED} [publication=${state.publication} command=${state.command} freshness=${state.freshness}]`, options);
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

async function defaultCommandRunner(toolCallId: string, input: ThenRunInput, signal: AbortSignal | undefined, ctx: ExtensionContext): Promise<string> {
	const bash = createBashToolDefinition(ctx.cwd);
	const result = await bash.execute(`${toolCallId}:then_run`, input, signal, undefined, ctx);
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

export function createActionFusionExecutor(commandRunner: CommandRunner = defaultCommandRunner, authorize?: ActionFusionAuthorizer) {
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
		toolName,
		absolutePath,
		thenRun,
		mutate,
		signal,
		ctx,
	}: {
		toolCallId: string;
		toolName: "edit" | "replace" | "write";
		absolutePath: string;
		thenRun: ThenRunInput | undefined;
		mutate: () => Promise<MutationResult<TDetails>>;
		signal: AbortSignal | undefined;
		ctx: ExtensionContext;
	}): Promise<MutationResult<TDetails>> {
		if (thenRun !== undefined) {
			validateThenRun(thenRun);
			await authorize?.({ toolName, absolutePath, cwd: ctx.cwd, thenRun });
		}
		return withQueue(absolutePath, async () => {
			try { signal?.throwIfAborted(); } catch (error) {
				if (thenRun !== undefined) throw new ActionFusionError("mutation was cancelled before it started; the command was not run", { publication: "NOT_PUBLISHED", command: "cancelled", freshness: "unknown" }, { cause: error });
				throw error;
			}
			let mutationResult: MutationResult<TDetails>;
			try {
				mutationResult = await mutate();
			} catch (error) {
				const publication = error instanceof FileMutationError ? error.publication : "NOT_PUBLISHED";
				if (thenRun !== undefined) {
					throw new ActionFusionError(`mutation ${error instanceof FileMutationError ? error.stage : "failed"}; the command was not run`, { publication, command: "skipped", freshness: "unknown" }, { cause: error });
				}
				throw error;
			}

			const publication = mutationPublication(mutationResult);
			if (thenRun === undefined) {
				return {
					...mutationResult,
					details: { ...(mutationResult.details as object ?? {}), actionFusion: { publication, command: "not_requested", freshness: "unknown" } satisfies ActionFusionDetails },
				} as MutationResult<TDetails>;
			}

			let baseline: string | undefined;
			try {
				baseline = await sha256(absolutePath);
				signal?.throwIfAborted();
				await assertUnchangedBeforeCommand(absolutePath, baseline);
				signal?.throwIfAborted();
			} catch (error) {
				const freshness = baseline ? await readFreshness(absolutePath, baseline) : "unknown";
				throw new ActionFusionError("mutation completed; the command was not run", { publication, command: signal?.aborted ? "cancelled" : "skipped", freshness }, { cause: error });
			}

			let output: string;
			let commandError: unknown;
			try {
				output = await commandRunner(toolCallId, thenRun, signal, ctx);
			} catch (error) {
				commandError = error;
				output = "";
			}
			const freshness = baseline ? await readFreshness(absolutePath, baseline) : "unknown";
			if (commandError !== undefined) {
				throw new ActionFusionError("mutation completed; then_run did not complete successfully", { publication, command: commandStatus(commandError, signal), freshness }, { cause: commandError });
			}

			const actionFusion: ActionFusionDetails = { publication, command: "succeeded", freshness };
			return {
				...mutationResult,
				details: { ...(mutationResult.details as object ?? {}), actionFusion },

				content: [...mutationResult.content, { type: "text", text: freshness === "unchanged" ? (output ? `${THEN_RUN_SUCCEEDED}\n${output}` : THEN_RUN_SUCCEEDED) : `${THEN_RUN_SUCCEEDED}\n${THEN_RUN_STALE} freshness=${freshness}${output ? `\n${output}` : ""}` }],
			} as MutationResult<TDetails>;
		});
	};
}
