import { TextDecoder } from "node:util";

/** Create an independent UTF-8 decoder; streaming calls preserve split code points and the BOM. */
export function createUtf8Decoder() {
  const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
  return (bytes?: Uint8Array, stream = false): string => {
    try {
      return decoder.decode(bytes, { stream });
    } catch (error) {
      throw new Error("UNSUPPORTED_ENCODING: expected valid UTF-8.", { cause: error });
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
  if (bytes.includes(0)) throw new Error("UNSUPPORTED_TEXT: NUL bytes are not editable.");
  return decodeUtf8(bytes);
}

/** Escape regex metacharacters for a standalone literal pattern in JS or ripgrep. */
export function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
