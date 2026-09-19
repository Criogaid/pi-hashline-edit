import { chmod, lstat, mkdir, mkdtemp, open, readFile, realpath, rename, rm, stat, link } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createHash } from "node:crypto";

export type PublicationStatus = "NOT_PUBLISHED" | "PUBLISHED" | "UNKNOWN";
export type CommitMode = "create" | "overwrite";

export interface CommitOptions {
	mode?: CommitMode;
	expectedRevision?: string;
	signal?: AbortSignal;
}

export interface CommitResult {
	created: boolean;
	revision: string;
	publication: "PUBLISHED";
}

export class FileMutationError extends Error {
	readonly stage: "prepare" | "commit" | "post_process";
	readonly publication: PublicationStatus;

	constructor(stage: "prepare" | "commit" | "post_process", publication: PublicationStatus, message: string, options?: { cause?: unknown }) {
		super(message, options);
		this.name = "FileMutationError";
		this.stage = stage;
		this.publication = publication;
	}
}

export async function fileRevision(path: string): Promise<string> {
	return createHash("sha256").update(await readFile(path)).digest("hex");
}

function prepareError(message: string, cause?: unknown): FileMutationError {
	return new FileMutationError("prepare", "NOT_PUBLISHED", message, { cause });
}

function errorCode(error: unknown): string | undefined {
	return typeof error === "object" && error !== null && "code" in error && typeof error.code === "string" ? error.code : undefined;
}

interface TargetInfo {
	existed: boolean;
	publishPath: string;
	beforeRevision?: string;
	modeBits?: number;
}

async function inspectTarget(path: string): Promise<TargetInfo> {
	let entry;
	try {
		entry = await lstat(path);
	} catch (error) {
		if (errorCode(error) === "ENOENT") return { existed: false, publishPath: path };
		throw prepareError(`unable to inspect target: ${error instanceof Error ? error.message : String(error)}`, error);
	}

	let publishPath = path;
	if (entry.isSymbolicLink()) {
		try {
			publishPath = await realpath(path);
		} catch (error) {
			throw prepareError(`target symlink cannot be resolved: ${error instanceof Error ? error.message : String(error)}`, error);
		}
	}

	let target;
	try {
		target = await stat(publishPath);
	} catch (error) {
		throw prepareError(`unable to inspect target: ${error instanceof Error ? error.message : String(error)}`, error);
	}
	if (!target.isFile()) throw prepareError("target is not a regular file");
	if (target.nlink > 1) throw prepareError("target has multiple hard links; refusing to split the link set");

	let beforeRevision: string;
	try {
		beforeRevision = await fileRevision(publishPath);
	} catch (error) {
		throw prepareError(`unable to read target revision: ${error instanceof Error ? error.message : String(error)}`, error);
	}
	return {
		existed: true,
		publishPath,
		beforeRevision,
		modeBits: target.mode,
	};
}

async function writeAndSyncTemp(tempPath: string, content: string, modeBits: number | undefined, signal: AbortSignal | undefined): Promise<void> {
	signal?.throwIfAborted();
	const handle = await open(tempPath, "w", modeBits === undefined ? 0o600 : modeBits & 0o7777);
	try {
		await handle.writeFile(content, "utf8");
		await handle.sync();
	} finally {
		await handle.close();
	}
	if (modeBits !== undefined) await chmod(tempPath, modeBits & 0o7777);
}

async function publishCreate(tempPath: string, targetPath: string, signal: AbortSignal | undefined): Promise<void> {
	// link() 在同一文件系统内创建不可覆盖的目录项，避免检查与发布之间的覆盖竞争。
	signal?.throwIfAborted();
	try {
		await link(tempPath, targetPath);
	} catch (error) {
		if (errorCode(error) === "EEXIST" || errorCode(error) === "ENOTEMPTY") {
			throw new FileMutationError("commit", "NOT_PUBLISHED", "target appeared during create; refusing to overwrite it", { cause: error });
		}
		throw new FileMutationError("commit", "UNKNOWN", `unable to publish new target: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
	}
}

async function publishReplace(tempPath: string, targetPath: string, signal: AbortSignal | undefined): Promise<void> {
	// rename() 替换目录项，但不会先删除旧文件；读者看到旧文件或完整新文件。
	signal?.throwIfAborted();
	try {
		await rename(tempPath, targetPath);
	} catch (error) {
		throw new FileMutationError("commit", "UNKNOWN", `unable to publish replacement: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
	}
}

async function syncDirectory(path: string): Promise<void> {
	if (process.platform === "win32") return;
	const handle = await open(path, "r");
	try {
		await handle.sync();
	} finally {
		await handle.close();
	}
}

/** 统一 mutation 提交：先准备并同步临时文件，再按创建/替换语义发布；调用方负责外层文件队列。 */
export async function commitFile(path: string, content: string, options: CommitOptions = {}): Promise<CommitResult> {
	const target = await inspectTarget(path);
	const mode = options.mode ?? (target.existed ? "overwrite" : "create");
	if (mode === "create" && target.existed) throw prepareError("target already exists; use mode=overwrite");
	if (mode === "overwrite" && !target.existed) throw prepareError("target does not exist; use mode=create or omit mode");
	if (mode === "create" && options.expectedRevision !== undefined) throw prepareError("expectedRevision cannot be combined with mode=create");
	if (options.expectedRevision !== undefined && (!target.beforeRevision || target.beforeRevision !== options.expectedRevision)) {
		throw prepareError("expectedRevision does not match the current file");
	}
	try { options.signal?.throwIfAborted(); } catch (error) { throw prepareError("mutation was cancelled before publication", error); }

	const publishPath = target.publishPath;
	const publishDirectory = dirname(publishPath);
	let tempDir: string;
	try {
		await mkdir(publishDirectory, { recursive: true });
		tempDir = await mkdtemp(join(publishDirectory, ".hashline-commit-"));
	} catch (error) {
		throw new FileMutationError("commit", "NOT_PUBLISHED", `unable to prepare temporary publication area: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
	}
	const tempPath = join(tempDir, "content");
	let published = false;
	let failure: unknown;
	try {
		await writeAndSyncTemp(tempPath, content, target.modeBits, options.signal);
		if (mode === "create") await publishCreate(tempPath, publishPath, options.signal);
		else await publishReplace(tempPath, publishPath, options.signal);
		published = true;
		await syncDirectory(publishDirectory);
		try {
			return { created: mode === "create", revision: await fileRevision(publishPath), publication: "PUBLISHED" };
		} catch (error) {
			throw new FileMutationError("post_process", "PUBLISHED", `target was published but final revision could not be read: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
		}
	} catch (error) {
		failure = error;
		if (error instanceof FileMutationError) throw error;
		if (published) throw new FileMutationError("post_process", "PUBLISHED", `target was published but post-publication processing failed: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
		throw new FileMutationError("commit", "NOT_PUBLISHED", `unable to prepare or publish target: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
	} finally {
		try {
			await rm(tempDir, { recursive: true, force: true });
		} catch (error) {
			if (!published) { if (failure !== undefined) throw failure; throw error; }
			throw new FileMutationError("post_process", "PUBLISHED", `target was published but temporary cleanup failed: ${error instanceof Error ? error.message : String(error)}`, { cause: failure === undefined ? error : new AggregateError([failure, error], "post-publication cleanup also failed") });
		}
	}
}
