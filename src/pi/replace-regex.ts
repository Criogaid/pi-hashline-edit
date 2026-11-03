/** Run a validated replacement batch through the shared isolated regex lifecycle. */
import {
  REPLACEMENT_RESULT_SCHEMA,
  type Replacement,
  type ReplacementResult,
} from "../core/replace-schema.ts";
import { workerReplyDecoder } from "./regex-worker-contract.ts";
import { withRegexWorker } from "./regex-worker.ts";

export interface ReplacementRequest {
  readonly source: string;
  readonly rules: readonly Replacement[];
}

/** Shared worker errors are checked by the host. */
export const decodeWorkerReply = workerReplyDecoder(REPLACEMENT_RESULT_SCHEMA);

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
