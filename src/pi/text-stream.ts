import { createReadStream } from "node:fs";
import { createUtf8Decoder } from "../core/text.ts";

/** Scan and validate the whole file with bounded chunks, preserving BOM and raw line endings. */
export async function scanTextFile(
  path: string,
  onChunk?: (text: string) => void | Promise<void>,
  signal?: AbortSignal,
) {
  const decode = createUtf8Decoder();
  let byteLength = 0;
  let lineFeeds = 0;
  let lastByte = -1;
  let hasNul = false;
  let hasCrLf = false;
  let decodingError: unknown;
  const stream = createReadStream(path, { highWaterMark: 64 * 1024, signal });
  for await (const chunk of stream) {
    const bytes = chunk as Buffer;
    byteLength += bytes.length;
    hasNul ||= bytes.includes(0);
    hasCrLf ||= (lastByte === 13 && bytes[0] === 10) || bytes.includes("\r\n");
    lastByte = bytes[bytes.length - 1];
    let offset = 0;
    while ((offset = bytes.indexOf(10, offset)) !== -1) {
      lineFeeds++;
      offset++;
    }
    // NUL takes precedence even when an earlier chunk contained malformed UTF-8.
    if (hasNul || decodingError) continue;
    let text: string;
    try {
      text = decode(bytes, true);
    } catch (error) {
      decodingError = error;
      continue;
    }
    await onChunk?.(text);
  }
  signal?.throwIfAborted();
  if (!hasNul) {
    if (decodingError) throw decodingError;
    const tail = decode();
    if (tail) await onChunk?.(tail);
  }
  return {
    byteLength,
    totalLines: lineFeeds + (lastByte !== -1 && lastByte !== 10 ? 1 : 0),
    finalNewline: lastByte === -1 || lastByte === 10,
    hasNul,
    hasCrLf,
  };
}

interface ScannedLine {
  number: number;
  byteLength: number;
  carriageReturns: number;
  /** Absent when the selected line exceeds maxLineBytes. */
  text: string | undefined;
}

/** Visit selected logical lines, retaining at most maxLineBytes of content per line. */
export async function scanTextLines(
  path: string,
  select: (number: number) => boolean,
  onLine: (line: ScannedLine) => void,
  options: { signal?: AbortSignal; maxLineBytes?: number } = {},
) {
  const maxBytes = options.maxLineBytes ?? Infinity;
  let number = 1;
  let byteLength = 0;
  let carriageReturns = 0;
  let parts: string[] = [];
  let selected = select(number);
  let lastChar = "";
  const finish = (terminated: boolean) => {
    if (selected) {
      const stripCr = terminated && lastChar === "\r";
      const logicalBytes = byteLength - (stripCr ? 1 : 0);
      let text = logicalBytes <= maxBytes ? parts.join("") : undefined;
      if (stripCr && text !== undefined) text = text.slice(0, -1);
      onLine({
        number,
        byteLength: logicalBytes,
        carriageReturns: carriageReturns - (stripCr ? 1 : 0),
        text,
      });
      carriageReturns = 0;
      byteLength = 0;
      parts = [];
      lastChar = "";
    }
    number++;
    selected = select(number);
  };
  const stats = await scanTextFile(
    path,
    (text) => {
      let start = 0;
      while (start < text.length) {
        const lf = text.indexOf("\n", start);
        if (selected) {
          const end = lf === -1 ? text.length : lf;
          const fragment = text.slice(start, end);
          byteLength += Buffer.byteLength(fragment);
          let cr = 0;
          while ((cr = fragment.indexOf("\r", cr)) !== -1) {
            carriageReturns++;
            cr++;
          }
          if (fragment) lastChar = fragment[fragment.length - 1];
          // Keep one extra byte until the terminator decides whether a final CR is content.
          if (byteLength <= maxBytes + 1) parts.push(fragment);
          else parts = [];
        }
        if (lf === -1) break;
        finish(true);
        start = lf + 1;
      }
    },
    options.signal,
  );
  if (!stats.hasNul && byteLength > 0) finish(false);
  return stats;
}
