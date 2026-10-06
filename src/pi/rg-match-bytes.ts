import { createHash, type Hash } from "node:crypto";
import { searchChangedError } from "./error-text.ts";

export interface RawMatchRevision {
  byteOffset: number;
  byteLength: number;
  lineNumber: number;
  endsAtEof: boolean;
  revision: string;
}

/** Retain one bounded digest of the whole rg event, including matched rows omitted by limit. */
export function rawMatchRevision(
  bytes: Buffer,
  lineNumber: number,
  byteOffset: number | undefined,
): RawMatchRevision {
  if (
    typeof byteOffset !== "number" ||
    !Number.isSafeInteger(byteOffset) ||
    byteOffset < 0 ||
    !Number.isSafeInteger(byteOffset + bytes.length)
  ) {
    throw new Error("Invalid rg raw match byte offset");
  }
  return {
    byteOffset,
    byteLength: bytes.length,
    lineNumber,
    endsAtEof: bytes[bytes.length - 1] !== 10,
    revision: createHash("sha256").update(bytes).digest("hex"),
  };
}

/** Verify exact raw match spans and their physical line positions during a bounded file scan. */
export function rawMatchVerifier(expected: ReadonlySet<RawMatchRevision>) {
  const spans = [...expected].sort((a, b) => a.byteOffset - b.byteOffset);
  let next = 0;
  let offset = 0;
  let lineNumber = 1;
  let lastByte = -1;
  let active: { span: RawMatchRevision; hash: Hash }[] = [];
  return {
    write(bytes: Buffer): void {
      if (next === spans.length && active.length === 0) {
        offset += bytes.length;
        return;
      }
      const chunkEnd = offset + bytes.length;
      let countedTo = 0;
      const countLinesBefore = (end: number) => {
        let lf: number;
        while ((lf = bytes.indexOf(10, countedTo)) !== -1 && lf < end) {
          lineNumber++;
          countedTo = lf + 1;
        }
        countedTo = end;
      };
      while (next < spans.length && spans[next].byteOffset < chunkEnd) {
        const span = spans[next++];
        const start = span.byteOffset - offset;
        countLinesBefore(start);
        const previousByte = start === 0 ? lastByte : bytes[start - 1];
        if (lineNumber !== span.lineNumber || (span.byteOffset !== 0 && previousByte !== 10)) {
          throw searchChangedError();
        }
        active.push({ span, hash: createHash("sha256") });
      }
      countLinesBefore(bytes.length);
      active = active.filter(({ span, hash }) => {
        const end = span.byteOffset + span.byteLength;
        hash.update(
          bytes.subarray(
            Math.max(0, span.byteOffset - offset),
            Math.min(bytes.length, end - offset),
          ),
        );
        if (end > chunkEnd) return true;
        if (hash.digest("hex") !== span.revision) throw searchChangedError();
        return false;
      });
      offset = chunkEnd;
      lastByte = bytes[bytes.length - 1] ?? lastByte;
    },
    end(): void {
      if (
        next !== spans.length ||
        active.length ||
        spans.some((span) => span.endsAtEof && span.byteOffset + span.byteLength !== offset)
      ) {
        throw searchChangedError();
      }
    },
  };
}
