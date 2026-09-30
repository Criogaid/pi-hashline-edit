import { createReadStream } from "node:fs";
import { createUtf8Decoder, type Utf8Decoding } from "../core/text.ts";
import { throwIfCancelled } from "./error-text.ts";

/** Scan whole-file bytes; preview decoding reports validity without rejecting malformed UTF-8. */
export async function scanTextFile(
  path: string,
  onChunk?: (text: string) => void | Promise<void>,
  signal?: AbortSignal,
  onBytes?: (bytes: Buffer) => void,
  decoding: Utf8Decoding = "strict",
) {
  const decode = createUtf8Decoder();
  // Strict decoding always decides validity; lossy text is decoded only for a chunk consumer.
  const preview = decoding === "preview" && onChunk ? createUtf8Decoder("preview") : undefined;
  let byteLength = 0;
  let lineFeeds = 0;
  let lastByte = -1;
  let hasNul = false;
  let hasCrLf = false;
  let decodingError: unknown;
  const stream = createReadStream(path, { highWaterMark: 64 * 1024, signal });
  try {
    for await (const chunk of stream) {
      const bytes = chunk as Buffer;
      onBytes?.(bytes);
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
      if (hasNul) continue;
      let text: string | undefined;
      if (!decodingError) {
        try {
          text = decode(bytes, true);
        } catch (error) {
          decodingError = error;
        }
      }
      if (preview) text = preview(bytes, true);
      if (text !== undefined) await onChunk?.(text);
    }
  } catch (error) {
    // Node's stream abort raises its own AbortError; report the shared cancellation text.
    throwIfCancelled(signal);
    throw error;
  }
  throwIfCancelled(signal);
  if (!hasNul) {
    let tail: string | undefined;
    if (!decodingError) {
      try {
        tail = decode();
      } catch (error) {
        decodingError = error;
      }
    }
    if (preview) tail = preview();
    else if (decodingError && decoding === "strict") throw decodingError;
    if (tail) await onChunk?.(tail);
  }
  return {
    byteLength,
    totalLines: lineFeeds + (lastByte !== -1 && lastByte !== 10 ? 1 : 0),
    finalNewline: lastByte === -1 || lastByte === 10,
    hasNul,
    hasCrLf,
    validUtf8: !decodingError,
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
  options: {
    signal?: AbortSignal;
    maxLineBytes?: number;
    onBytes?: (bytes: Buffer) => void;
    decoding?: Utf8Decoding;
  } = {},
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
    options.onBytes,
    options.decoding,
  );
  if (!stats.hasNul && byteLength > 0) finish(false);
  return stats;
}
