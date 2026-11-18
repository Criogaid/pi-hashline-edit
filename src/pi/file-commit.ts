/**
 * File mutation commit: target checks, atomic publication, freshness, and
 * revision tracking.
 *
 * @module pi-hashline-edit/pi
 */

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
  type FileHandle,
} from "node:fs/promises";
import type { BigIntStats, Stats } from "node:fs";
import { dirname, join } from "node:path";
import { byteRevision } from "./file-revision.ts";
import { decodeEditableText, unwritableTextError } from "../core/text.ts";
import {
  errnoCode,
  filesystemErrorCode,
  PATH_ERROR_MESSAGES,
  pathError,
  HashlineError,
} from "../core/errors.ts";
import { FileChangedDuringReadError, throwIfCancelled } from "./error-text.ts";
import { withFileRead } from "./file-read.ts";
import type { Freshness, PublicationStatus } from "./report-schema.ts";

/**
 * How a commit treats the target. `create` requires that it not exist. `overwrite` requires
 * that it exist; with `baseRevision` (read-modify-write), the target must still hold the bytes
 * that revision names, and that revision stands in for hashing the target again.
 */
type CommitOptions = { readonly signal?: AbortSignal } & (
  | { readonly mode: "create" }
  | { readonly mode: "overwrite"; readonly baseRevision?: string }
);

/** The published bytes' revision and, when stable, the revision observed right after. */
interface CommitRevisions {
  readonly publishedRevision: string;
  /** Absent when a concurrent change prevented a stable observation after publication. */
  readonly observedRevision?: string;
}

export type CommitResult = CommitRevisions &
  (
    | { readonly publication: "PUBLISHED" }
    | { readonly publication: "NOT_PUBLISHED"; readonly observedRevision: string }
  );

/**
 * A mutation failure with what it published. Every other failure of a mutation
 * tool published nothing, so it stays a plain HashlineError.
 */
export class FileMutationError extends HashlineError<"PUBLISH_FAILED" | "POST_PROCESS_FAILED"> {
  readonly publication: PublicationStatus;

  constructor(
    code: "PUBLISH_FAILED" | "POST_PROCESS_FAILED",
    publication: PublicationStatus,
    message: string,
    options?: { readonly cause?: unknown },
  ) {
    super(code, message, options);
    this.name = "FileMutationError";
    this.publication = publication;
  }
}

function requireRegularFile(target: Stats | BigIntStats): void {
  if (!target.isFile())
    throw new HashlineError("NOT_REGULAR_FILE", PATH_ERROR_MESSAGES.NOT_REGULAR_FILE);
}

const REGULAR_FILE_READ_CHUNK_BYTES = 64 * 1024;

/** Read a regular file in full, even when the filesystem returns short reads. */
async function readRegularFileBytes(
  handle: FileHandle,
  size: bigint,
  signal: AbortSignal | undefined,
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let position = 0n;
  while (position < size) {
    throwIfCancelled(signal);
    const remaining = size - position;
    const length = Number(
      remaining < BigInt(REGULAR_FILE_READ_CHUNK_BYTES)
        ? remaining
        : BigInt(REGULAR_FILE_READ_CHUNK_BYTES),
    );
    const buffer = Buffer.allocUnsafe(length);
    const result = await handle.read({
      buffer,
      offset: 0,
      length,
      position: Number(position),
    });
    if (result.bytesRead <= 0 || result.bytesRead > length) throw new FileChangedDuringReadError();
    chunks.push(buffer.subarray(0, result.bytesRead));
    position += BigInt(result.bytesRead);
  }
  return Buffer.concat(chunks);
}

/** Check the opened object before reading; a FIFO must not block even if the path changed. */
async function readRegularFile(path: string, signal?: AbortSignal): Promise<Buffer> {
  return withFileRead(path, signal, async (handle, before) => {
    requireRegularFile(before);
    return readRegularFileBytes(handle, before.size, signal);
  });
}

async function fileRevision(path: string, signal?: AbortSignal): Promise<string> {
  return byteRevision(await readRegularFile(path, signal));
}

/** Decode and bind a mutation snapshot to the exact bytes read. */
export async function readEditableSnapshot(path: string, signal: AbortSignal | undefined) {
  try {
    const bytes = await readRegularFile(path, signal);
    return { text: decodeEditableText(bytes), baseRevision: byteRevision(bytes) };
  } catch (error) {
    throwIfCancelled(signal);
    throw error;
  }
}

/**
 * A failure of a filesystem step before publication: the step is the message, the failure its
 * cause, whose classification it keeps. A missing path or directory target keeps its own report,
 * whichever step found it.
 */
function stepError(step: string, error: unknown): HashlineError {
  const code =
    error instanceof HashlineError
      ? error.errorCode
      : (filesystemErrorCode(error) ?? "FILESYSTEM_ERROR");
  return pathError(error) ?? new HashlineError(code, step, { cause: error });
}

/** The target must still hold the bytes a mutation read; cancellation wins over what this read finds. */
async function requireBaseRevision(
  path: string,
  baseRevision: string,
  signal: AbortSignal | undefined,
): Promise<void> {
  let currentRevision: string;
  try {
    currentRevision = await fileRevision(path, signal);
  } catch (error) {
    throwIfCancelled(signal);
    throw stepError("Unable to recheck target revision.", error);
  }
  throwIfCancelled(signal);
  if (currentRevision !== baseRevision)
    throw new HashlineError("FILE_CHANGED", "File changed after it was read.");
}

interface TargetInfo {
  readonly publishPath: string;
  readonly modeBits: number;
}

/** Resolve existing targets so staging and cleanup stay beside the inspected file. */
async function inspectTarget(path: string): Promise<TargetInfo | undefined> {
  let entry;
  try {
    entry = await lstat(path);
  } catch (error) {
    if (errnoCode(error) === "ENOENT") return undefined;
    throw stepError("Unable to inspect target.", error);
  }

  let publishPath: string;
  try {
    publishPath = await realpath(path);
  } catch (error) {
    if (!entry.isSymbolicLink()) throw stepError("Unable to resolve target.", error);
    throw new HashlineError("SYMLINK_UNRESOLVED", "Target symlink cannot be resolved.", {
      cause: error,
    });
  }

  let target;
  try {
    target = await stat(publishPath);
  } catch (error) {
    throw stepError("Unable to inspect target.", error);
  }
  requireRegularFile(target);
  if (target.nlink > 1)
    throw new HashlineError(
      "MULTIPLE_HARD_LINKS",
      "Target has multiple hard links; publishing would split the link set.",
    );

  return { publishPath, modeBits: target.mode };
}

async function requireOverwriteTarget(path: string, baseRevision: string | undefined) {
  const target = await inspectTarget(path);
  if (!target)
    throw new HashlineError("PATH_NOT_FOUND", PATH_ERROR_MESSAGES.PATH_NOT_FOUND, {
      facts: { missing: [path] },
      // Read-modify-write tools have no mode to change.
      next: baseRevision === undefined ? "useCreate" : undefined,
    });
  return target;
}

async function writeAndSyncTemp(
  tempPath: string,
  content: Buffer,
  modeBits: number | undefined,
  signal: AbortSignal | undefined,
): Promise<void> {
  throwIfCancelled(signal);
  // A new file takes the umask's default mode; its private temp directory hides it until publication.
  const handle = await open(tempPath, "w");
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
      throw new HashlineError("TARGET_EXISTS", "Target appeared during create.", { cause: error });
    }
    throw new FileMutationError("PUBLISH_FAILED", "UNKNOWN", "Unable to publish new target.", {
      cause: error,
    });
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
    throw new FileMutationError("PUBLISH_FAILED", "UNKNOWN", "Unable to publish replacement.", {
      cause: error,
    });
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

/**
 * A temporary directory beside the target. Recursive mkdir fails with EPERM on a Windows
 * drive root even though it exists, so it runs only when the directory is missing.
 */
async function makeTempDirectory(directory: string): Promise<string> {
  const prefix = join(directory, ".hashline-commit-");
  try {
    return await mkdtemp(prefix);
  } catch (error) {
    if (errnoCode(error) !== "ENOENT") throw error;
  }
  await mkdir(directory, { recursive: true });
  return mkdtemp(prefix);
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
  if (unwritable) throw unwritable;
  const bytes = Buffer.from(content, "utf8");
  const { mode } = options;
  const baseRevision = mode === "overwrite" ? options.baseRevision : undefined;
  const target =
    mode === "overwrite" ? await requireOverwriteTarget(path, baseRevision) : undefined;
  if (mode === "create" && (await inspectTarget(path)))
    throw new HashlineError("TARGET_EXISTS", "Target already exists.");
  throwIfCancelled(options.signal);
  const publishedRevision = byteRevision(bytes);
  const verifyOverwrite = async (initial: TargetInfo) => {
    if (baseRevision !== undefined) await requireBaseRevision(path, baseRevision, options.signal);
    const current = await requireOverwriteTarget(path, baseRevision);
    throwIfCancelled(options.signal);
    if (current.publishPath !== initial.publishPath)
      throw new HashlineError("FILE_CHANGED", "Target path resolves to a different file.");
  };
  let beforeRevision = baseRevision;
  if (target && beforeRevision === undefined) {
    try {
      beforeRevision = await fileRevision(path, options.signal);
    } catch (error) {
      throwIfCancelled(options.signal);
      throw stepError("Unable to read target revision.", error);
    }
  }
  // Check a bound snapshot even when the transformation produced no change.
  if (target && beforeRevision === publishedRevision) {
    await verifyOverwrite(target);
    return {
      publishedRevision,
      observedRevision: publishedRevision,
      publication: "NOT_PUBLISHED",
    };
  }

  const publishPath = target?.publishPath ?? path;
  const publishDirectory = dirname(publishPath);
  let tempDir: string;
  try {
    tempDir = await makeTempDirectory(publishDirectory);
  } catch (error) {
    throw new HashlineError("PUBLISH_FAILED", "Unable to prepare temporary publication area.", {
      cause: error,
    });
  }
  const tempPath = join(tempDir, "content");
  let published = false;
  try {
    await writeAndSyncTemp(tempPath, bytes, target?.modeBits, options.signal);
    if (target) {
      await verifyOverwrite(target);
      await publishReplace(tempPath, publishPath, options.signal);
    } else {
      await publishCreate(tempPath, publishPath, options.signal);
    }
    published = true;
    await syncDirectory(publishDirectory);
    const committed: CommitResult = {
      publishedRevision,
      publication: "PUBLISHED",
    };
    try {
      return { ...committed, observedRevision: await fileRevision(path) };
    } catch (error) {
      // Another writer is replacing the published bytes: report a changed target, not a failed
      // mutation whose retry would apply it again.
      if (error instanceof FileChangedDuringReadError) return committed;
      throw new FileMutationError(
        "POST_PROCESS_FAILED",
        "PUBLISHED",
        "Final revision could not be read.",
        { cause: error },
      );
    }
  } catch (error) {
    // Already classified, including cancellation and every publication failure.
    if (error instanceof HashlineError) throw error;
    if (published)
      throw new FileMutationError(
        "POST_PROCESS_FAILED",
        "PUBLISHED",
        "Post-publication processing failed.",
        { cause: error },
      );
    throw new HashlineError("PUBLISH_FAILED", "Unable to prepare or publish target.", {
      cause: error,
    });
  } finally {
    // Best effort: a leftover temporary directory changes neither the publication nor the recovery.
    await rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
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
export function commitFreshness(commit: CommitRevisions): FreshnessObservation {
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
