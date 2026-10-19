/** Run a validated replacement batch through the shared isolated regex lifecycle. */
import type { Replacement, ReplacementResult } from "../core/replace-schema.ts";
import { decodeWorkerReply, type ReplacementRequest } from "./replace-worker-contract.ts";
import { withRegexWorker } from "./regex-worker.ts";

export function runRegexReplacements(
  source: string,
  rules: readonly Replacement[],
  timeoutMs: number,
  signal: AbortSignal | undefined,
): Promise<ReplacementResult> {
  return withRegexWorker<ReplacementRequest, ReplacementResult, ReplacementResult>(
    new URL("./replace-worker.mjs", import.meta.url),
    decodeWorkerReply,
    timeoutMs,
    signal,
    (run) => run({ source, rules }),
  );
}
