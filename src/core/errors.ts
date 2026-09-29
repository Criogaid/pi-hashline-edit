/** Error-code messages shared by core validation and the tool layer. */
export const UNSUPPORTED_ENCODING = "UNSUPPORTED_ENCODING: expected valid UTF-8.";
export const UNSUPPORTED_TEXT_NUL = "UNSUPPORTED_TEXT: NUL bytes are not editable.";
export const INVALID_UNICODE = "INVALID_UNICODE: content cannot be encoded losslessly as UTF-8.";

/** Message text for a caught value; non-Error throws are stringified. */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
