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
  type HashlineErrorArguments,
} from "../core/errors.ts";
import { cancellationError, FileChangedDuringReadError, throwIfCancelled } from "./error-text.ts";
import { withFileRead } from "./file-read.ts";
import type { Freshness, MutationStage, PublicationStatus } from "./report-schema.ts";

/**
 * How a commit treats the target. `create` requires that it not exist. `overwrite` requires
 * that it exist; with `baseRevision` (read-modify-write), the target must still hold the bytes
 * that revision names, and that revision stands in for hashing the target again.
 */
export type CommitOptions = { readonly signal?: AbortSignal } & (
  | { readonly mode: "create" }
  | { readonly mode: "overwrite"; readonly baseRevision?: string }
);

export interface MutationVersions {
  baseRevision?: string;
  publishedRevision: string;
  /** Absent when a concurrent change prevented a stable observation after publication. */
  observedRevision?: string;
}

export type CommitResult = MutationVersions &
  (
    | { readonly created: true; readonly publication: "PUBLISHED"; readonly baseRevision?: never }
    | { readonly created: false; readonly publication: "PUBLISHED"; readonly baseRevision: string }
    | {
        readonly created: false;
        readonly publication: "NOT_PUBLISHED";
        readonly baseRevision: string;
        readonly observedRevision: string;
      }
  );

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
    ...options: HashlineErrorArguments<NoInfer<C>>
  ) {
    super(code, message, ...options);
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
  return commitFile(path, text, { mode: "overwrite", baseRevision, signal });
}

function prepareError<C extends ErrorCode>(
  code: C,
  message: string,
  ...options: HashlineErrorArguments<NoInfer<C>>
): FileMutationError<C> {
  return new FileMutationError(code, "prepare", "NOT_PUBLISHED", message, ...options);
}

/** A classified failure before any publication step keeps its code, facts, cause, and recovery. */
function asPrepareError<C extends ErrorCode>(error: HashlineError<C>): FileMutationError<C> {
  // The original constructor already enforced its code's facts; preserve that correlated tuple.
  return prepareError(
    error.errorCode,
    error.message,
    ...([
      {
        cause: error.cause,
        next: error.next,
        facts: error.facts,
      },
    ] as HashlineErrorArguments<C>),
  );
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

type TargetInfo = { readonly publishPath: string } & (
  | { readonly existed: true; readonly beforeRevision: string; readonly modeBits: number }
  | { readonly existed: false; readonly beforeRevision?: never; readonly modeBits?: never }
);

/** The target's state before publication; a known revision stands in for hashing it again. */
async function inspectTarget(path: string, knownRevision?: string): Promise<TargetInfo> {
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
  if (knownRevision !== undefined) {
    beforeRevision = knownRevision;
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
  const { mode } = options;
  const baseRevision = mode === "overwrite" ? options.baseRevision : undefined;
  const target = await inspectTarget(path, baseRevision);
  if (mode === "create" && target.existed)
    throw prepareError("TARGET_EXISTS", "Target already exists.");
  if (mode === "overwrite" && !target.existed)
    throw prepareError("PATH_NOT_FOUND", "Target does not exist.", { next: "useCreate" });
  throwIfCancelledBeforePublication(options.signal);
  const publishedRevision = byteRevision(bytes);
  // Mode, revision, target safety, and cancellation checks still apply to no-ops.
  if (target.beforeRevision === publishedRevision) {
    // A base revision was not hashed from the target here; confirm the target still holds it.
    if (baseRevision !== undefined) {
      let currentRevision: string;
      try {
        throwIfCancelledBeforePublication(options.signal);
        currentRevision = await fileRevision(target.publishPath);
        throwIfCancelledBeforePublication(options.signal);
      } catch (error) {
        if (options.signal?.aborted) throw asPrepareError(cancellationError());
        throw stepError("Unable to read target revision.", error);
      }
      if (currentRevision !== baseRevision)
        throw prepareError("FILE_CHANGED", "File changed after it was read.");
    }
    return {
      created: false,
      baseRevision: target.beforeRevision,
      publishedRevision,
      observedRevision: publishedRevision,
      publication: "NOT_PUBLISHED",
    };
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
    if (baseRevision !== undefined) {
      let currentRevision: string;
      try {
        currentRevision = await fileRevision(publishPath);
      } catch (error) {
        throw stepError("Unable to recheck target revision.", error);
      }
      if (currentRevision !== baseRevision)
        throw prepareError("FILE_CHANGED", "File changed before publication.");
    }
    if (mode === "create") await publishCreate(tempPath, publishPath, options.signal);
    else await publishReplace(tempPath, publishPath, options.signal);
    published = true;
    await syncDirectory(publishDirectory);
    const committed: CommitResult = {
      ...(target.existed
        ? { created: false, baseRevision: target.beforeRevision }
        : { created: true, baseRevision: target.beforeRevision }),
      publishedRevision,
      publication: "PUBLISHED",
    };
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
export type FreshnessObservation =
  | { readonly freshness: Exclude<Freshness, "unknown">; readonly error?: never }
  | {
      readonly freshness: "unknown";
      /** Why the revision could not be read. */
      readonly error: unknown;
    };

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
