/** Guard file reads with metadata observations; byte revisions still own search and commit freshness. */
import { constants, type BigIntStats } from "node:fs";
import { open, stat, type FileHandle } from "node:fs/promises";
import { Utf8DecodingError } from "../core/text.ts";
import { fileChangedDuringReadError, throwIfCancelled } from "./error-text.ts";

function sameObservation(before: BigIntStats, after: BigIntStats): boolean {
  return (
    before.dev === after.dev &&
    before.ino === after.ino &&
    before.size === after.size &&
    before.mtimeNs === after.mtimeNs &&
    before.ctimeNs === after.ctimeNs
  );
}

/**
 * Compare the opened file and current path before accepting bytes or an encoding error.
 * This detects observable writes/replacements, not changes hidden by filesystem timestamp resolution.
 * The callback owns its stream; the handle closes on success, failure, and cancellation.
 */
export async function withFileRead<T>(
  path: string,
  signal: AbortSignal | undefined,
  read: (handle: FileHandle, before: BigIntStats) => Promise<T>,
): Promise<T> {
  throwIfCancelled(signal);
  const flags = constants.O_RDONLY | (process.platform === "win32" ? 0 : constants.O_NONBLOCK);
  const handle = await open(path, flags);
  try {
    throwIfCancelled(signal);
    const before = await handle.stat({ bigint: true });
    const outcome = await read(handle, before).then(
      (value) => ({ ok: true, value }) as const,
      (error: unknown) => ({ ok: false, error }) as const,
    );
    throwIfCancelled(signal);
    if (outcome.ok || outcome.error instanceof Utf8DecodingError) {
      const after = await handle.stat({ bigint: true });
      let current: BigIntStats;
      try {
        current = await stat(path, { bigint: true });
      } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") {
          throw fileChangedDuringReadError(error);
        }
        throw error;
      }
      throwIfCancelled(signal);
      if (!sameObservation(before, after) || !sameObservation(before, current)) {
        throw fileChangedDuringReadError(outcome.ok ? undefined : outcome.error);
      }
    }
    if (!outcome.ok) throw outcome.error;
    return outcome.value;
  } finally {
    await handle.close();
  }
}
