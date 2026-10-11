/** Replacement-specific result shape; shared worker errors are checked by the host. */
import { Type } from "typebox";
import { workerReplyDecoder } from "./regex-worker-contract.ts";
import type { Replacement } from "../core/replace.ts";

export interface ReplacementRequest {
  readonly source: string;
  readonly rules: readonly Replacement[];
}

export const decodeWorkerReply = workerReplyDecoder(
  Type.Object(
    {
      text: Type.String(),
      count: Type.Integer({ minimum: 1 }),
    },
    { additionalProperties: false },
  ),
);
