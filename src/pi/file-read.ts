/** Guard snapshots and streamed revisions with the same handle and path observations. */
import { constants, createReadStream, type BigIntStats, type Stats } from "node:fs";
import { open, stat } from "node:fs/promises";
import { errnoCode, HashlineError, PATH_ERROR_MESSAGES } from "../core/errors.ts";
import { decodeEditableText } from "../core/text.ts";
import { FileChangedDuringReadError, throwIfCancelled } from "./error-text.ts";
import { createRevisionHasher } from "./file-revision.ts";

const READ_CHUNK_BYTES = 64 * 1024;

export function requireRegularFile(target: Stats | BigIntStats): void {
  if (!target.isFile())
    throw new HashlineError("NOT_REGULAR_FILE", PATH_ERROR_MESSAGES.NOT_REGULAR_FILE);
}

function sameObservation(before: BigIntStats, after: BigIntStats): boolean {
  return (
    before.dev === after.dev &&
    before.ino === after.ino &&
    before.size === after.size &&
    before.mtimeNs === after.mtimeNs &&
    before.ctimeNs === after.ctimeNs
  );
}

type ByteConsumer = {
  readonly onChunk: (bytes: Buffer) => void | Promise<void>;
} & (
  | { readonly extent: "size" }
  | { readonly extent: "eof"; readonly onEnd: () => void | Promise<void> }
);

/**
 * Hash the actual bytes and check the opened file and current path before returning their revision.
 * Metadata cannot detect changes hidden by timestamp resolution.
 * Mutations bind to the initial size of a regular file. Only editable snapshots retain the chunks.
 * Text scans use Node’s read-ahead to EOF, including virtual files that report zero size.
 */
export async function readFileRevision(
  path: string,
  signal: AbortSignal,
  consumer?: ByteConsumer,
): Promise<string> {
  throwIfCancelled(signal);
  const flags = constants.O_RDONLY | (process.platform === "win32" ? 0 : constants.O_NONBLOCK);
  const handle = await open(path, flags);
  try {
    throwIfCancelled(signal);
    const before = await handle.stat({ bigint: true });
    const revision = createRevisionHasher();
    const consume = (bytes: Buffer) => {
      revision.update(bytes);
      return consumer?.onChunk(bytes);
    };
    try {
      if (consumer?.extent === "eof") {
        const stream = createReadStream(path, {
          fd: handle,
          autoClose: false,
          highWaterMark: READ_CHUNK_BYTES,
          signal,
        });
        for await (const chunk of stream) {
          // With no encoding set, Node emits Buffers.
          const pending = consume(chunk as Buffer);
          if (pending) await pending;
        }
        throwIfCancelled(signal);
        await consumer.onEnd();
      } else {
        requireRegularFile(before);
        if (before.size > 0n) {
          const scratch = consumer
            ? undefined
            : Buffer.allocUnsafe(Math.min(Number(before.size), READ_CHUNK_BYTES));
          let position = 0n;
          while (position < before.size) {
            const length = Math.min(Number(before.size - position), READ_CHUNK_BYTES);
            const buffer = scratch ?? Buffer.allocUnsafe(length);
            let offset = 0;
            while (offset < length) {
              throwIfCancelled(signal);
              const remaining = length - offset;
              const { bytesRead } = await handle.read({
                buffer,
                offset,
                length: remaining,
                position: Number(position + BigInt(offset)),
              });
              throwIfCancelled(signal);
              if (bytesRead <= 0 || bytesRead > remaining) throw new FileChangedDuringReadError();
              offset += bytesRead;
            }
            const pending = consume(length === buffer.length ? buffer : buffer.subarray(0, length));
            if (pending) await pending;
            position += BigInt(length);
          }
        }
      }
    } catch (error) {
      throwIfCancelled(signal);
      throw error;
    }
    throwIfCancelled(signal);
    const after = await handle.stat({ bigint: true });
    let current: BigIntStats;
    try {
      current = await stat(path, { bigint: true });
    } catch (error) {
      if (errnoCode(error) === "ENOENT") throw new FileChangedDuringReadError();
      throw error;
    }
    throwIfCancelled(signal);
    if (!sameObservation(before, after) || !sameObservation(before, current))
      throw new FileChangedDuringReadError();
    return revision.digest();
  } finally {
    await handle.close();
  }
}

/** Decode and bind a mutation snapshot to the exact bytes read. */
export async function readEditableSnapshot(path: string, signal: AbortSignal) {
  const chunks: Buffer[] = [];
  try {
    const baseRevision = await readFileRevision(path, signal, {
      extent: "size",
      onChunk: (bytes) => {
        chunks.push(bytes);
      },
    });
    const bytes = chunks.length === 1 ? chunks[0] : Buffer.concat(chunks);
    return { text: decodeEditableText(bytes), baseRevision };
  } catch (error) {
    throwIfCancelled(signal);
    throw error;
  }
}
