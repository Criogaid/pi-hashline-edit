import { TextDecoder } from "node:util";

import { INVALID_UNICODE, UNSUPPORTED_ENCODING, UNSUPPORTED_TEXT_NUL } from "./errors.ts";

/** Why text cannot be written as editable UTF-8 (NUL or unpaired surrogates); undefined when it can. */
export function unwritableTextReason(text: string): string | undefined {
  if (text.includes("\0")) return UNSUPPORTED_TEXT_NUL;
  if (!text.isWellFormed()) return INVALID_UNICODE;
  return undefined;
}

export type Utf8Decoding = "strict" | "lossy";

/** Streaming UTF-8 decoding preserves BOM; lossy mode replaces malformed bytes with U+FFFD. */
export function createUtf8Decoder(mode: Utf8Decoding = "strict") {
  const decoder = new TextDecoder("utf-8", { fatal: mode === "strict", ignoreBOM: true });
  if (mode === "lossy") {
    return (bytes?: Uint8Array, stream = false): string => decoder.decode(bytes, { stream });
  }
  return (bytes?: Uint8Array, stream = false): string => {
    try {
      return decoder.decode(bytes, { stream });
    } catch (error) {
      throw new Error(UNSUPPORTED_ENCODING, { cause: error });
    }
  };
}

const decode = createUtf8Decoder();

/** Decode UTF-8 without replacing malformed bytes; preserve a leading BOM for byte-stable rewrites. */
export function decodeUtf8(bytes: Uint8Array): string {
  return decode(bytes);
}

/** Reject byte-oriented/binary content before entering a text mutation pipeline. */
export function decodeEditableText(bytes: Uint8Array): string {
  if (bytes.includes(0)) throw new Error(UNSUPPORTED_TEXT_NUL);
  return decodeUtf8(bytes);
}

/** Escape regex metacharacters for a standalone literal pattern in JS or ripgrep. */
export function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
