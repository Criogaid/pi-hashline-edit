import { Type, type Static } from "typebox";

export const SEARCH_RESULT_SCHEMA = Type.Object(
  {
    lines: Type.Array(
      Type.Object(
        {
          lineNumber: Type.Integer({ minimum: 1 }),
          column: Type.Integer({ minimum: 0 }),
        },
        { additionalProperties: false },
      ),
    ),
    totalLines: Type.Integer({ minimum: 0 }),
  },
  { additionalProperties: false },
);
export type SearchResult = Static<typeof SEARCH_RESULT_SCHEMA>;
