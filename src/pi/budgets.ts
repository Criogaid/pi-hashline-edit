/**
 * Model-facing byte budgets. README "Output budgets" documents this policy.
 * The context window is a capacity hint, not a tokenizer or remaining-context counter.
 */

// A read is a chosen window of one file; a grep is a probe whose size the caller cannot predict.
// At four bytes per token a full read spends about a sixteenth of the window, a full grep a
// thirty-second.
const READ_SHARE = 4;
const GREP_SHARE = 8;
// A preview grows with the payload: one UTF-16 unit per this many payload bytes.
const GREP_PREVIEW_SHARE = 100;
// Pi's built-in grep keeps this many characters of a line. A narrower preview cuts a row in
// far more calls and keeps almost none of them within the payload budget.
const MIN_GREP_PREVIEW_UNITS = 500;
const BLOCK_SHARE = 4;
const FIELD_SHARE = 4;
// Keep JSON envelopes and diagnostic omission markers usable for tiny declared windows.
const MIN_BLOCK_BYTES = 512;
const MIN_FIELD_BYTES = 128;
// Capacity counted toward the budgets stops here; config.ts reuses this constant for the
// read.maxKiB range, so automatic sizing never surpasses what a user could configure.
export const MAX_CONTENT_KIB = 4096;
const MAX_CONTENT_BYTES = MAX_CONTENT_KIB * 1024;

/** The leading entries whose compact JSON array fits `maxBytes`; whole entries are omitted, never cut. */
export function leadingEntriesWithin<T>(entries: readonly T[], maxBytes: number): T[] {
  const kept: T[] = [];
  let bytes = 1; // Brackets less the comma charged to the first entry.
  for (const entry of entries) {
    bytes += Buffer.byteLength(JSON.stringify(entry)) + 1;
    if (bytes > maxBytes) break;
    kept.push(entry);
  }
  return kept;
}

// Declared apart so Object.freeze keeps these as numbers rather than literal types.
const fallbackBudgets = {
  readBytes: 64 * 1024,
  grepBytes: 50 * 1024,
  blockBytes: 16 * 1024,
  fieldBytes: 4 * 1024,
  grepPreviewUnits: MIN_GREP_PREVIEW_UNITS,
};
const DEFAULT_OUTPUT_BUDGETS = Object.freeze(fallbackBudgets);
export type OutputBudgets = typeof DEFAULT_OUTPUT_BUDGETS;
export type OutputBudgetProvider = () => OutputBudgets;

/** Unknown or invalid capacity uses the bounded defaults; each returned budget is immutable. */
export function outputBudgetsFor(contextWindow: number | undefined): OutputBudgets {
  if (contextWindow === undefined || !Number.isSafeInteger(contextWindow) || contextWindow <= 0) {
    return DEFAULT_OUTPUT_BUDGETS;
  }
  // One byte per declared context token, shared out below.
  const contentBytes = Math.min(contextWindow, MAX_CONTENT_BYTES);
  const grepBytes = Math.max(MIN_BLOCK_BYTES, Math.floor(contentBytes / GREP_SHARE));
  const blockBytes = Math.max(MIN_BLOCK_BYTES, Math.floor(contentBytes / BLOCK_SHARE));
  const fieldBytes = Math.max(MIN_FIELD_BYTES, Math.floor(blockBytes / FIELD_SHARE));
  return Object.freeze({
    readBytes: Math.max(MIN_BLOCK_BYTES, Math.floor(contentBytes / READ_SHARE)),
    grepBytes,
    blockBytes,
    fieldBytes,
    grepPreviewUnits: Math.max(MIN_GREP_PREVIEW_UNITS, Math.floor(grepBytes / GREP_PREVIEW_SHARE)),
  });
}

const MIB = 1024 * 1024;

/** Size wording for every model-facing limit: whole MiB as `256 MiB`, otherwise `195.3 KiB`. */
export function formatByteSize(bytes: number): string {
  return bytes % MIB === 0 ? `${bytes / MIB} MiB` : `${Number((bytes / 1024).toFixed(1))} KiB`;
}
