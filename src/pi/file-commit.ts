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
import { dirname, join } from "node:path";
import { byteRevision } from "./file-revision.ts";
import { unwritableTextError } from "../core/text.ts";
import {
  errnoCode,
  filesystemErrorCode,
  PATH_ERROR_MESSAGES,
  pathError,
  HashlineError,
} from "../core/errors.ts";
import { FileChangedDuringReadError, throwIfCancelled } from "./error-text.ts";
import { readFileRevision, requireRegularFile } from "./file-read.ts";
import type { Freshness, PublicationStatus } from "./report-schema.ts";

/**
 * How a commit treats the target. `create` requires that it not exist. `overwrite` requires that
 * it exist and replaces it whole. `update` (read-modify-write) also requires that it still hold
 * the bytes `baseRevision` names, and that revision stands in for hashing the target again.
 */
type CommitIntent =
  | { readonly mode: "create" }
  | { readonly mode: "overwrite" }
  | { readonly mode: "update"; readonly baseRevision: string };

type ReplaceMode = Exclude<CommitIntent["mode"], "create">;

/** What publication does, decided once the target has been inspected. */
type PublishPlan =
  | { readonly kind: "create" }
  | {
      readonly kind: "replace";
      readonly mode: ReplaceMode;
      readonly target: TargetInfo;
      /** The revision the target holds before the commit; an update's base revision. */
      readonly beforeRevision: string;
    };

/**
 * The published bytes' revision, and whether the target still held them right after the
 * commit; an unstable observation after publication means another writer changed it. Content
 * equal to the target's is not published, and the target is unchanged.
 */
export type CommitResult = { readonly publishedRevision: string } & (
  | { readonly publication: "NOT_PUBLISHED"; readonly freshness: "unchanged" }
  | {
      readonly publication: "PUBLISHED";
      readonly freshness: Extract<Freshness, "unchanged" | "changed">;
    }
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

/** Observations of a published target run to completion: the report must state what was published. */
const UNCANCELLABLE = new AbortController().signal;

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
  signal: AbortSignal,
): Promise<void> {
  let currentRevision: string;
  try {
    currentRevision = await readFileRevision(path, signal);
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

async function requireExistingTarget(path: string, mode: ReplaceMode) {
  const target = await inspectTarget(path);
  if (!target)
    throw new HashlineError("PATH_NOT_FOUND", PATH_ERROR_MESSAGES.PATH_NOT_FOUND, {
      facts: { missing: [path] },
      // Read-modify-write tools have no mode to change.
      ...(mode === "overwrite" ? { next: "useCreate" as const } : {}),
    });
  return target;
}

/** Inspect the target once and decide how to publish over it. */
async function planPublication(
  path: string,
  intent: CommitIntent,
  signal: AbortSignal,
): Promise<PublishPlan> {
  if (intent.mode === "create") {
    if (await inspectTarget(path))
      throw new HashlineError("TARGET_EXISTS", "Target already exists.");
    throwIfCancelled(signal);
    return { kind: "create" };
  }
  const { mode } = intent;
  const target = await requireExistingTarget(path, mode);
  throwIfCancelled(signal);
  if (mode === "update")
    return { kind: "replace", mode, target, beforeRevision: intent.baseRevision };
  try {
    return { kind: "replace", mode, target, beforeRevision: await readFileRevision(path, signal) };
  } catch (error) {
    throwIfCancelled(signal);
    throw stepError("Unable to read target revision.", error);
  }
}

/** Before replacing: an update's base revision still holds and the path names the inspected file. */
async function recheckReplace(
  path: string,
  plan: Extract<PublishPlan, { readonly kind: "replace" }>,
  signal: AbortSignal,
): Promise<void> {
  if (plan.mode === "update") await requireBaseRevision(path, plan.beforeRevision, signal);
  const current = await requireExistingTarget(path, plan.mode);
  throwIfCancelled(signal);
  if (current.publishPath !== plan.target.publishPath)
    throw new HashlineError("FILE_CHANGED", "Target path resolves to a different file.");
}

async function writeAndSyncTemp(
  tempPath: string,
  content: Buffer,
  signal: AbortSignal,
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
}

async function publishCreate(
  tempPath: string,
  targetPath: string,
  signal: AbortSignal,
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
  signal: AbortSignal,
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

/** After the publish syscall succeeds, an unstable target is a change by another writer. */
async function publishedFreshness(
  path: string,
  revision: string,
): Promise<"unchanged" | "changed"> {
  try {
    return (await readFileRevision(path, UNCANCELLABLE)) === revision ? "unchanged" : "changed";
  } catch (error) {
    if (error instanceof FileChangedDuringReadError) return "changed";
    throw new FileMutationError(
      "POST_PROCESS_FAILED",
      "PUBLISHED",
      "Final revision could not be read.",
      { cause: error },
    );
  }
}

/** Validate the target, skip identical content, otherwise sync and publish. Callers own the file queue. */
export async function commitFile(
  path: string,
  content: string,
  intent: CommitIntent,
  signal: AbortSignal,
): Promise<CommitResult> {
  // The argument boundary rejects such input, but a transformation can still produce it
  // (a regex without `u` can split a surrogate pair), so publication keeps the final check.
  const unwritable = unwritableTextError(content);
  if (unwritable) throw unwritable;
  const bytes = Buffer.from(content, "utf8");
  // Hash before reading the target's revision, so no hashing time separates that read from the
  // no-change decision below.
  const publishedRevision = byteRevision(bytes);
  const plan = await planPublication(path, intent, signal);
  // Check a bound snapshot even when the transformation produced no change.
  if (plan.kind === "replace" && plan.beforeRevision === publishedRevision) {
    await recheckReplace(path, plan, signal);
    return { publication: "NOT_PUBLISHED", publishedRevision, freshness: "unchanged" };
  }

  const publishPath = plan.kind === "replace" ? plan.target.publishPath : path;
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
  try {
    try {
      await writeAndSyncTemp(tempPath, bytes, signal);
      if (plan.kind === "replace") {
        await chmod(tempPath, plan.target.modeBits & 0o7777);
        await recheckReplace(path, plan, signal);
        await publishReplace(tempPath, publishPath, signal);
      } else {
        await publishCreate(tempPath, publishPath, signal);
      }
    } catch (error) {
      if (error instanceof HashlineError) throw error;
      throw new HashlineError("PUBLISH_FAILED", "Unable to prepare or publish target.", {
        cause: error,
      });
    }
    await syncDirectory(publishDirectory).catch((error: unknown) => {
      throw new FileMutationError(
        "POST_PROCESS_FAILED",
        "PUBLISHED",
        "Post-publication processing failed.",
        { cause: error },
      );
    });
    return {
      publication: "PUBLISHED",
      publishedRevision,
      freshness: await publishedFreshness(path, publishedRevision),
    };
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
    const first = await readFileRevision(path, UNCANCELLABLE);
    if (settle) {
      await new Promise<void>((resolve) => setImmediate(resolve));
      if ((await readFileRevision(path, UNCANCELLABLE)) !== first) return { freshness: "changed" };
    }
    return { freshness: first === publishedRevision ? "unchanged" : "changed" };
  } catch (error) {
    // A write observed during the read has already moved the target off the published revision.
    if (error instanceof FileChangedDuringReadError) return { freshness: "changed" };
    if (errnoCode(error) === "ENOENT") return { freshness: "missing" };
    return { freshness: "unknown", error };
  }
}
