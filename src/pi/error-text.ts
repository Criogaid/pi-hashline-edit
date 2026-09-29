/** Message text for a caught value; non-Error throws are stringified. */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
