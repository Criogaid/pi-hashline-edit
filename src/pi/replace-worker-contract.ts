/** Replacement worker request and reply decoder; shared worker errors are checked by the host. */
import { workerReplyDecoder } from "./regex-worker-contract.ts";
import { REPLACEMENT_RESULT_SCHEMA, type Replacement } from "../core/replace-schema.ts";

export interface ReplacementRequest {
  readonly source: string;
  readonly rules: readonly Replacement[];
}

export const decodeWorkerReply = workerReplyDecoder(REPLACEMENT_RESULT_SCHEMA);
