/**
 * Streaming text scans: one read of a file yields its revision, its NUL and UTF-8 validity, line
 * statistics, and the decoded text or selected lines.
 *
 * @module pi-hashline-edit/pi
 */
import { createUtf8Decoder, Utf8DecodingError, type Utf8Decoding } from "../core/text.ts";
import { readFileRevision } from "./file-read.ts";

/**
 * Scan whole-file bytes; lossy decoding reports validity without rejecting malformed UTF-8.
 * The revision covers exactly the bytes this scan read; onChunk also receives the bytes read so far.
 */
export async function scanTextFile(
  path: string,
  options: {
    readonly onChunk?: (text: string, bytesRead: number) => void | Promise<void>;
    readonly signal: AbortSignal;
    readonly decoding?: Utf8Decoding;
  },
) {
  const { onChunk, signal, decoding = "strict" } = options;
  const decode = createUtf8Decoder();
  // Strict decoding always decides validity; lossy text is decoded only for a chunk consumer.
  const lossy =
    decoding === "lossy" && onChunk ? { decode: createUtf8Decoder("lossy"), onChunk } : undefined;
  let byteLength = 0;
  let lineFeeds = 0;
  let lastByte = -1;
  let hasNul = false;
  let decodingError: Utf8DecodingError | undefined;
  /** Strict text of a chunk, or of the final flush without bytes; undefined once malformed. */
  const decodeStrict = (bytes?: Buffer): string | undefined => {
    if (decodingError) return undefined;
    try {
      return decode(bytes, bytes !== undefined);
    } catch (error) {
      if (!(error instanceof Utf8DecodingError)) throw error;
      decodingError = error;
      return undefined;
    }
  };
  const revision = await readFileRevision(path, signal, {
    extent: "eof",
    onChunk(bytes) {
      byteLength += bytes.length;
      hasNul ||= bytes.includes(0);
      lastByte = bytes[bytes.length - 1];
      let offset = 0;
      while ((offset = bytes.indexOf(10, offset)) !== -1) {
        lineFeeds++;
        offset++;
      }
      // NUL takes precedence even when an earlier chunk contained malformed UTF-8.
      if (hasNul) return;
      const text = decodeStrict(bytes);
      if (lossy) {
        const { decode, onChunk } = lossy;
        return onChunk(decode(bytes, true), byteLength);
      }
      if (text !== undefined) return onChunk?.(text, byteLength);
    },
    onEnd() {
      if (hasNul) return;
      let tail = decodeStrict();
      if (lossy) tail = lossy.decode();
      if (tail) return onChunk?.(tail, byteLength);
    },
  });
  // A changed observation or a NUL anywhere takes precedence over an encoding error.
  if (decoding === "strict" && !hasNul && decodingError) throw decodingError;
  return {
    revision,
    totalLines: lineFeeds + (lastByte !== -1 && lastByte !== 10 ? 1 : 0),
    finalNewline: lastByte === -1 || lastByte === 10,
    hasNul,
    validUtf8: !decodingError,
  };
}

interface ScannedLine {
  readonly number: number;
  readonly byteLength: number;
  readonly carriageReturns: number;
  readonly text: string;
}

/** A bound on the bytes retained per line, and what receives a selected line beyond it. */
interface LineBound {
  readonly maxBytes: number;
  /** Called for a selected line longer than maxBytes, in place of onLine. */
  readonly onExceeded: () => void;
}

/** Visit selected logical lines; with a bound, a longer line goes to its onExceeded. */
export async function scanTextLines(
  path: string,
  select: (number: number) => boolean,
  onLine: (line: ScannedLine) => void,
  options: {
    readonly signal: AbortSignal;
    readonly decoding?: Utf8Decoding;
    readonly bound?: LineBound;
  },
) {
  const { signal, decoding, bound } = options;
  const maxBytes = bound ? bound.maxBytes : Infinity;
  let number = 1;
  let byteLength = 0;
  let carriageReturns = 0;
  let parts: string[] = [];
  let selected = select(number);
  let lastChar = "";
  const finish = (terminatorCrBytes: 0 | 1) => {
    if (selected) {
      const logicalBytes = byteLength - terminatorCrBytes;
      if (bound && logicalBytes > bound.maxBytes) bound.onExceeded();
      else {
        const text = parts.join("");
        onLine({
          number,
          byteLength: logicalBytes,
          carriageReturns: carriageReturns - terminatorCrBytes,
          text: terminatorCrBytes === 0 ? text : text.slice(0, -terminatorCrBytes),
        });
      }
      carriageReturns = 0;
      byteLength = 0;
      parts = [];
      lastChar = "";
    }
    number++;
    selected = select(number);
  };
  const stats = await scanTextFile(path, {
    signal,
    decoding,
    onChunk: (text) => {
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
        finish(lastChar === "\r" ? 1 : 0);
        start = lf + 1;
      }
    },
  });
  if (!stats.hasNul && byteLength > 0) finish(0);
  return stats;
}
