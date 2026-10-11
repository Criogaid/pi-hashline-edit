/** Run a validated replacement batch through the shared isolated regex lifecycle. */
import type { applyReplacements, Replacement } from "../core/replace.ts";
import { decodeWorkerReply, type ReplacementRequest } from "./replace-worker-contract.ts";
import { withRegexWorker } from "./regex-worker.ts";

type ReplaceResult = ReturnType<typeof applyReplacements>;

export function runRegexReplacements(
  source: string,
  rules: readonly Replacement[],
  timeoutMs: number,
  signal: AbortSignal | undefined,
): Promise<ReplaceResult> {
  return withRegexWorker<ReplacementRequest, ReplaceResult, ReplaceResult>(
    new URL("./replace-worker.mjs", import.meta.url),
    decodeWorkerReply,
    timeoutMs,
    signal,
    (run) => run({ source, rules }),
  );
}
