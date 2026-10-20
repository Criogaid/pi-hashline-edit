/**
 * Model-facing byte budgets. README "Output budgets" documents this policy.
 * The context window is a capacity hint, not a tokenizer or remaining-context counter.
 */

const BYTES_PER_CONTEXT_TOKEN = 1;
const BLOCK_SHARE = 4;
const FIELD_SHARE = 4;
const UTF16_PREVIEW_BYTES = 4;
// Keep JSON envelopes and diagnostic omission markers usable for tiny declared windows.
const MIN_BLOCK_BYTES = 512;
const MIN_FIELD_BYTES = 128;
// Model-derived content budgets never exceed the explicit read cap's ceiling; config.ts
// reuses this constant for the read.maxKiB range, so automatic sizing may approach but
// not surpass what a user could configure, keeping one absolute bound per call.
export const MAX_CONTENT_KIB = 4096;
const MAX_CONTENT_BYTES = MAX_CONTENT_KIB * 1024;

const fallbackBudgets = {
  readBytes: 256 * 1024,
  grepBytes: 50 * 1024,
  blockBytes: 16 * 1024,
  fieldBytes: 4 * 1024,
  grepPreviewUnits: 500,
};
export const DEFAULT_OUTPUT_BUDGETS = Object.freeze(fallbackBudgets);
export type OutputBudgets = typeof DEFAULT_OUTPUT_BUDGETS;
export type OutputBudgetProvider = () => OutputBudgets;

/** Unknown or invalid capacity uses the bounded defaults; each returned budget is immutable. */
export function outputBudgetsFor(contextWindow: number | undefined): OutputBudgets {
  if (contextWindow === undefined || !Number.isSafeInteger(contextWindow) || contextWindow <= 0) {
    return DEFAULT_OUTPUT_BUDGETS;
  }
  const contentBytes = Math.min(contextWindow * BYTES_PER_CONTEXT_TOKEN, MAX_CONTENT_BYTES);
  const blockBytes = Math.max(MIN_BLOCK_BYTES, Math.floor(contentBytes / BLOCK_SHARE));
  const fieldBytes = Math.max(MIN_FIELD_BYTES, Math.floor(blockBytes / FIELD_SHARE));
  return Object.freeze({
    readBytes: contentBytes,
    grepBytes: contentBytes,
    blockBytes,
    fieldBytes,
    grepPreviewUnits: Math.floor(fieldBytes / UTF16_PREVIEW_BYTES),
  });
}

/** Standalone tool factories have no session model until a provider is supplied. */
export const defaultOutputBudgets: OutputBudgetProvider = () => DEFAULT_OUTPUT_BUDGETS;

const MIB = 1024 * 1024;

/** Size wording for every model-facing limit: whole MiB as `256 MiB`, otherwise `16 KiB`. */
export function formatByteSize(bytes: number): string {
  return bytes % MIB === 0 ? `${bytes / MIB} MiB` : `${bytes / 1024} KiB`;
}
