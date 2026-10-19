/** Tool-validated replacement rules, the engine's result, and their types; no Pi runtime imports. */
import { Type, type Static } from "typebox";

export const REPLACEMENT_SCHEMA = Type.Object(
  {
    find: Type.String({
      minLength: 1,
      description:
        "Text to find, read as literal decides. CRLF in the file reads as LF, so a line break is \\n; in literal mode a backslash followed by n matches those two characters. In regex mode, ^ and $ need the m flag to match per line; \\d, \\w, and \\b are ASCII-based.",
    }),
    literal: Type.Boolean({
      description:
        "true: find matches exactly, including regex punctuation, and replace keeps $ as is. false: find is a JavaScript regex and replace expands $1, $<name>, and $&; use it only for an intentional regex.",
    }),
    replace: Type.String({
      description: "Replacement text; the file's line endings are kept.",
    }),
    flags: Type.Optional(
      Type.String({
        description: "Extra regex flags, also applied in literal mode; g is always added.",
      }),
    ),
  },
  { additionalProperties: false },
);

export const REPLACEMENTS_SCHEMA = Type.Array(REPLACEMENT_SCHEMA, {
  minItems: 1,
  description: "Rules applied to the original content; inserted text is not searched again.",
});
export type Replacement = Readonly<Static<typeof REPLACEMENT_SCHEMA>>;

/** A replacement batch's new text and match count; the host checks it again across the worker boundary. */
export const REPLACEMENT_RESULT_SCHEMA = Type.Object(
  {
    text: Type.String(),
    count: Type.Integer({ minimum: 1 }),
  },
  { additionalProperties: false },
);
export type ReplacementResult = Static<typeof REPLACEMENT_RESULT_SCHEMA>;
