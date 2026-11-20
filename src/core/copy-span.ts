import { Type, type Static } from "typebox";

/**
 * Equal raw UTF-16 slices in the source and target, ordered and non-overlapping on both sides.
 * Gaps between spans have unknown provenance.
 */
export const COPIED_SPAN_SCHEMA = Type.Object(
  {
    sourceStart: Type.Integer({ minimum: 0 }),
    targetStart: Type.Integer({ minimum: 0 }),
    length: Type.Integer({ minimum: 1 }),
  },
  { additionalProperties: false },
);
export type CopiedSpan = Readonly<Static<typeof COPIED_SPAN_SCHEMA>>;
