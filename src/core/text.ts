import { TextDecoder } from "node:util";

import { HashlineError, TEXT_ERROR_MESSAGES } from "./errors.ts";

/** Why text cannot be written as editable UTF-8 (NUL or unpaired surrogates); undefined when it can. */
export function unwritableTextError(text: string): HashlineError | undefined {
  if (text.includes("\0"))
    return new HashlineError("UNSUPPORTED_TEXT", TEXT_ERROR_MESSAGES.UNSUPPORTED_TEXT);
  if (!text.isWellFormed())
    return new HashlineError("INVALID_UNICODE", TEXT_ERROR_MESSAGES.INVALID_UNICODE);
  return undefined;
}

export type Utf8Decoding = "strict" | "lossy";

/** Confirmed malformed UTF-8, distinct from decoder input or resource failures. */
export class Utf8DecodingError extends HashlineError {
  constructor(cause: unknown) {
    super("UNSUPPORTED_ENCODING", TEXT_ERROR_MESSAGES.UNSUPPORTED_ENCODING, { cause });
  }
}

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
      if (
        error instanceof TypeError &&
        "code" in error &&
        error.code === "ERR_ENCODING_INVALID_ENCODED_DATA"
      ) {
        throw new Utf8DecodingError(error);
      }
      throw error;
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
  if (bytes.includes(0))
    throw new HashlineError("UNSUPPORTED_TEXT", TEXT_ERROR_MESSAGES.UNSUPPORTED_TEXT);
  return decodeUtf8(bytes);
}

/** Escape regex metacharacters for a standalone literal pattern in JS or ripgrep. */
export function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
