import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  open,
  realpath,
  rename,
  rm,
  stat,
  link,
} from "node:fs/promises";
import type { BigIntStats, Stats } from "node:fs";
import { dirname, join } from "node:path";
import { createHash } from "node:crypto";
import { decodeEditableText, unwritableTextError } from "../core/text.ts";
import {
  errnoCode,
  filesystemErrorCode,
  HashlineError,
  type ErrorCode,
  type HashlineErrorOptions,
} from "../core/errors.ts";
import { cancellationError, FileChangedDuringReadError, throwIfCancelled } from "./error-text.ts";
import { withFileRead } from "./file-read.ts";
import type { Freshness, MutationStage, PublicationStatus } from "./report-schema.ts";

export type CommitMode = "create" | "overwrite";

export interface CommitOptions {
  mode: CommitMode;
  expectedRevision?: string;
  signal?: AbortSignal;
  /** Caller-supplied revision of the current file, skipping the readFile + SHA-256 in inspectTarget. */
  knownBeforeRevision?: string;
}

export interface MutationVersions {
  baseRevision?: string;
  publishedRevision: string;
  /** Absent when a concurrent change prevented a stable observation after publication. */
  observedRevision?: string;
}

export interface CommitResult extends MutationVersions {
  created: boolean;
  publication: "NOT_PUBLISHED" | "PUBLISHED";
}

/**
 * A mutation failure with the stage it reached and what it published. Other
 * failures of a mutation tool happened while preparing and published nothing.
 */
export class FileMutationError<C extends ErrorCode = ErrorCode> extends HashlineError<C> {
  readonly stage: MutationStage;
  readonly publication: PublicationStatus;

  constructor(
    code: C,
    stage: MutationStage,
    publication: PublicationStatus,
    message: string,
    options?: HashlineErrorOptions<C>,
  ) {
    super(code, message, ...([options] as [HashlineErrorOptions<C>]));
    this.name = "FileMutationError";
    this.stage = stage;
    this.publication = publication;
  }
}

export function byteRevision(content: string | Uint8Array): string {
  return createHash("sha256").update(content).digest("hex");
}

function requireRegularFile(target: Stats | BigIntStats): void {
  if (!target.isFile()) throw prepareError("NOT_REGULAR_FILE", "Target is not a regular file.");
}

/** Check the opened object before reading; a FIFO must not block even if the path changed. */
async function readRegularFile(path: string, signal?: AbortSignal): Promise<Buffer> {
  return withFileRead(path, signal, async (handle, before) => {
    requireRegularFile(before);
    return handle.readFile({ signal });
  });
}

export async function fileRevision(path: string): Promise<string> {
  return byteRevision(await readRegularFile(path));
}

/** Decode and bind a mutation snapshot to the exact bytes read. */
export async function readEditableSnapshot(path: string, signal?: AbortSignal) {
  try {
    const bytes = await readRegularFile(path, signal);
    return { text: decodeEditableText(bytes), baseRevision: byteRevision(bytes) };
  } catch (error) {
    if (signal?.aborted) throw asPrepareError(cancellationError());
    throw error;
  }
}

/** Publish a read-modify-write result against its source revision. Callers own the queue. */
export function commitReplacement(
  path: string,
  text: string,
  baseRevision: string,
  signal?: AbortSignal,
): Promise<CommitResult> {
  return commitFile(path, text, {
    mode: "overwrite",
    expectedRevision: baseRevision,
    knownBeforeRevision: baseRevision,
    signal,
  });
}

function prepareError<C extends ErrorCode>(
  code: C,
  message: string,
  options?: HashlineErrorOptions<C>,
): FileMutationError<C> {
  return new FileMutationError(code, "prepare", "NOT_PUBLISHED", message, options);
}

/** A classified failure before any publication step keeps its code, facts, cause, and recovery. */
function asPrepareError<C extends ErrorCode>(error: HashlineError<C>): FileMutationError<C> {
  return prepareError(error.errorCode, error.message, {
    cause: error.cause,
    next: error.next,
    facts: error.facts,
  } as HashlineErrorOptions<C>);
}

function throwIfCancelledBeforePublication(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw asPrepareError(cancellationError());
}

/** A failed filesystem step keeps the classification of its cause. */
function causeCode(error: unknown, fallback: ErrorCode): ErrorCode {
  return error instanceof HashlineError
    ? error.errorCode
    : (filesystemErrorCode(error) ?? fallback);
}

/** A prepare-stage failure of a filesystem step: the step is the message, the failure its cause. */
function stepError(step: string, error: unknown): FileMutationError {
  return prepareError(causeCode(error, "FILESYSTEM_ERROR"), step, { cause: error });
}

interface TargetInfo {
  existed: boolean;
  publishPath: string;
  beforeRevision?: string;
  modeBits?: number;
}

async function inspectTarget(path: string, knownBeforeRevision?: string): Promise<TargetInfo> {
  let entry;
  try {
    entry = await lstat(path);
  } catch (error) {
    if (errnoCode(error) === "ENOENT") return { existed: false, publishPath: path };
    throw stepError("Unable to inspect target.", error);
  }

  let publishPath = path;
  if (entry.isSymbolicLink()) {
    try {
      publishPath = await realpath(path);
    } catch (error) {
      throw prepareError("SYMLINK_UNRESOLVED", "Target symlink cannot be resolved.", {
        cause: error,
      });
    }
  }

  let target;
  try {
    target = await stat(publishPath);
  } catch (error) {
    throw stepError("Unable to inspect target.", error);
  }
  requireRegularFile(target);
  if (target.nlink > 1)
    throw prepareError(
      "MULTIPLE_HARD_LINKS",
      "Target has multiple hard links; publishing would split the link set.",
    );

  let beforeRevision: string;
  if (knownBeforeRevision !== undefined) {
    beforeRevision = knownBeforeRevision;
  } else {
    try {
      beforeRevision = await fileRevision(publishPath);
    } catch (error) {
      throw stepError("Unable to read target revision.", error);
    }
  }
  return {
    existed: true,
    publishPath,
    beforeRevision,
    modeBits: target.mode,
  };
}

async function writeAndSyncTemp(
  tempPath: string,
  content: Buffer,
  modeBits: number | undefined,
  signal: AbortSignal | undefined,
): Promise<void> {
  throwIfCancelled(signal);
  const handle = await open(tempPath, "w", modeBits === undefined ? 0o600 : modeBits & 0o7777);
  try {
    await handle.writeFile(content);
    await handle.sync();
  } finally {
    await handle.close();
  }
  if (modeBits !== undefined) await chmod(tempPath, modeBits & 0o7777);
}

async function publishCreate(
  tempPath: string,
  targetPath: string,
  signal: AbortSignal | undefined,
): Promise<void> {
  // link() creates an unclobberable directory entry on the same filesystem, avoiding create/replace races.
  throwIfCancelled(signal);
  try {
    await link(tempPath, targetPath);
  } catch (error) {
    if (errnoCode(error) === "EEXIST" || errnoCode(error) === "ENOTEMPTY") {
      throw new FileMutationError(
        "TARGET_EXISTS",
        "commit",
        "NOT_PUBLISHED",
        "Target appeared during create.",
        { cause: error },
      );
    }
    throw new FileMutationError(
      "PUBLISH_FAILED",
      "commit",
      "UNKNOWN",
      "Unable to publish new target.",
      { cause: error },
    );
  }
}

async function publishReplace(
  tempPath: string,
  targetPath: string,
  signal: AbortSignal | undefined,
): Promise<void> {
  // rename() replaces the directory entry atomically without deleting the old file first; readers observe old or new.
  throwIfCancelled(signal);
  try {
    await rename(tempPath, targetPath);
  } catch (error) {
    throw new FileMutationError(
      "PUBLISH_FAILED",
      "commit",
      "UNKNOWN",
      "Unable to publish replacement.",
      { cause: error },
    );
  }
}

async function syncDirectory(path: string): Promise<void> {
  if (process.platform === "win32") return;
  const handle = await open(path, "r");
  try {
    await handle.sync();
  } catch (error) {
    // Some filesystems do not support directory fsync; preserve real I/O failures.
    if (errnoCode(error) !== "EINVAL" && errnoCode(error) !== "ENOTSUP") throw error;
  } finally {
    await handle.close();
  }
}

/** Validate the target, skip identical content, otherwise sync and publish. Callers own the file queue. */
export async function commitFile(
  path: string,
  content: string,
  options: CommitOptions,
): Promise<CommitResult> {
  // Tools reject such input in prepareArguments, but a transformation can still produce it
  // (a regex without `u` can split a surrogate pair), so publication keeps the final check.
  const unwritable = unwritableTextError(content);
  if (unwritable) throw asPrepareError(unwritable);
  const bytes = Buffer.from(content, "utf8");
  const target = await inspectTarget(path, options.knownBeforeRevision);
  const { mode } = options;
  if (mode === "create" && target.existed)
    throw prepareError("TARGET_EXISTS", "Target already exists.");
  if (mode === "overwrite" && !target.existed)
    throw prepareError("PATH_NOT_FOUND", "Target does not exist.", { next: "useCreate" });
  if (mode === "create" && options.expectedRevision !== undefined)
    throw prepareError("UNCLASSIFIED", "expectedRevision cannot be combined with mode=create.");
  if (
    options.expectedRevision !== undefined &&
    (!target.beforeRevision || target.beforeRevision !== options.expectedRevision)
  ) {
    throw prepareError("FILE_CHANGED", "File changed after it was read.");
  }
  throwIfCancelledBeforePublication(options.signal);
  const publishedRevision = byteRevision(bytes);
  // Mode, revision, target safety, and cancellation checks still apply to no-ops.
  if (target.beforeRevision === publishedRevision) {
    let currentRevision = target.beforeRevision;
    if (options.knownBeforeRevision !== undefined) {
      try {
        throwIfCancelledBeforePublication(options.signal);
        currentRevision = await fileRevision(target.publishPath);
        throwIfCancelledBeforePublication(options.signal);
      } catch (error) {
        if (options.signal?.aborted) throw asPrepareError(cancellationError());
        throw stepError("Unable to read target revision.", error);
      }
      if (options.expectedRevision !== undefined && currentRevision !== options.expectedRevision) {
        throw prepareError("FILE_CHANGED", "File changed after it was read.");
      }
      if (currentRevision !== publishedRevision) {
        target.beforeRevision = currentRevision;
      }
    }
    if (target.beforeRevision === publishedRevision) {
      return {
        created: false,
        baseRevision: target.beforeRevision,
        publishedRevision,
        observedRevision: currentRevision,
        publication: "NOT_PUBLISHED",
      };
    }
  }

  const publishPath = target.publishPath;
  const publishDirectory = dirname(publishPath);
  let tempDir: string;
  try {
    await mkdir(publishDirectory, { recursive: true });
    tempDir = await mkdtemp(join(publishDirectory, ".hashline-commit-"));
  } catch (error) {
    throw new FileMutationError(
      "PUBLISH_FAILED",
      "commit",
      "NOT_PUBLISHED",
      "Unable to prepare temporary publication area.",
      { cause: error },
    );
  }
  const tempPath = join(tempDir, "content");
  let published = false;
  let failure: unknown;
  try {
    await writeAndSyncTemp(tempPath, bytes, target.modeBits, options.signal);
    if (mode === "overwrite" && options.expectedRevision !== undefined) {
      let currentRevision: string;
      try {
        currentRevision = await fileRevision(publishPath);
      } catch (error) {
        throw stepError("Unable to recheck target revision.", error);
      }
      if (currentRevision !== options.expectedRevision)
        throw prepareError("FILE_CHANGED", "File changed before publication.");
    }
    if (mode === "create") await publishCreate(tempPath, publishPath, options.signal);
    else await publishReplace(tempPath, publishPath, options.signal);
    published = true;
    await syncDirectory(publishDirectory);
    const committed = {
      created: mode === "create",
      baseRevision: target.beforeRevision,
      publishedRevision,
      publication: "PUBLISHED",
    } as const;
    try {
      return { ...committed, observedRevision: await fileRevision(publishPath) };
    } catch (error) {
      // Another writer is replacing the published bytes: report a changed target, not a failed
      // mutation whose retry would apply it again.
      if (error instanceof FileChangedDuringReadError) return committed;
      throw new FileMutationError(
        "POST_PROCESS_FAILED",
        "post_process",
        "PUBLISHED",
        "Final revision could not be read.",
        { cause: error },
      );
    }
  } catch (error) {
    failure = error;
    if (error instanceof FileMutationError) throw error;
    if (published)
      throw new FileMutationError(
        "POST_PROCESS_FAILED",
        "post_process",
        "PUBLISHED",
        "Post-publication processing failed.",
        { cause: error },
      );
    // Cancellation keeps its own record; any other failure here stopped before publication.
    if (error instanceof HashlineError && error.errorCode === "OPERATION_ABORTED")
      throw new FileMutationError("OPERATION_ABORTED", "commit", "NOT_PUBLISHED", error.message);
    throw new FileMutationError(
      "PUBLISH_FAILED",
      "commit",
      "NOT_PUBLISHED",
      "Unable to prepare or publish target.",
      { cause: error },
    );
  } finally {
    try {
      await rm(tempDir, { recursive: true, force: true });
    } catch (error) {
      if (!published) {
        if (failure !== undefined) throw failure;
        throw error;
      }
      throw new FileMutationError(
        "POST_PROCESS_FAILED",
        "post_process",
        "PUBLISHED",
        "Temporary cleanup failed.",
        {
          cause:
            failure === undefined
              ? error
              : new AggregateError([failure, error], "post-publication cleanup also failed"),
        },
      );
    }
  }
}

/** What the commit layer knows about the target relative to its published revision. */
export interface FreshnessObservation {
  readonly freshness: Freshness;
  /** Why the revision could not be read, when freshness is unknown. */
  readonly error?: unknown;
}

/** Freshness known from the commit result alone, before any later observation. */
export function commitFreshness(commit: MutationVersions): FreshnessObservation {
  return {
    freshness: commit.publishedRevision === commit.observedRevision ? "unchanged" : "changed",
  };
}

/**
 * Read the target again and compare it with the published revision. With
 * `settle`, two reads across a turn of the event loop catch a write in progress.
 * A failed read is itself an observation: the mutation is already published, so
 * a concurrent change or deletion must not suggest retrying it.
 */
export async function observeFreshness(
  path: string,
  publishedRevision: string,
  settle = false,
): Promise<FreshnessObservation> {
  try {
    const first = await fileRevision(path);
    if (settle) {
      await new Promise<void>((resolve) => setImmediate(resolve));
      if ((await fileRevision(path)) !== first) return { freshness: "changed" };
    }
    return { freshness: first === publishedRevision ? "unchanged" : "changed" };
  } catch (error) {
    // A write observed during the read has already moved the target off the published revision.
    if (error instanceof FileChangedDuringReadError) return { freshness: "changed" };
    if (errnoCode(error) === "ENOENT") return { freshness: "missing" };
    return { freshness: "unknown", error };
  }
}
