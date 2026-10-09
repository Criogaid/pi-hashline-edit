/** Pure report contracts. No host imports; types and recovery policy derive from these schemas. */
import { Type, type Static, type TSchema, type TLiteral, type TUnion } from "typebox";

const object = <P extends Record<string, TSchema>>(properties: P) =>
  Type.Object(properties, { additionalProperties: false });
const strings = Type.Array(Type.String());
const count = Type.Integer({ minimum: 0 });
const optionalCount = Type.Optional(count);
function choices<const T extends readonly [string, ...string[]]>(
  values: T,
): TUnion<{ -readonly [K in keyof T]: TLiteral<T[K]> }> {
  // Array.map cannot preserve tuple positions; the values are the same literals in the same order.
  return Type.Union(values.map((value) => Type.Literal(value))) as TUnion<{
    -readonly [K in keyof T]: TLiteral<T[K]>;
  }>;
}

export const recoveryText = {
  reread: "Read the file before further edits.",
  published: "Do not repeat the saved change.",
  uncertain: "The change may already be applied; inspect the file before retrying.",
} as const;
const empty = object({});
const matched = { matched: Type.Optional(strings), omittedMatched: optionalCount };
export const anchorFailureSchema = object({
  field: Type.String(),
  op: Type.String(),
  cited: Type.String(),
  result: choices(["shifted", "ambiguous", "unresolved"] as const),
  search: Type.Optional(choices(["local", "full-file"] as const)),
  candidate: Type.Optional(Type.String()),
  content: Type.Optional(Type.String()),
  contentOmitted: Type.Optional(Type.Literal("row_too_large")),
  candidates: Type.Optional(strings),
  omittedCandidates: optionalCount,
  observed: Type.Optional(Type.String()),
  observedOmitted: Type.Optional(choices(["out_of_range", "row_too_large"] as const)),
});
export type AnchorFailureFact = Static<typeof anchorFailureSchema>;
const neighborhoodSchema = object({ lines: Type.String(), rows: strings });
export const argumentIssueSchema = object({
  field: Type.String(),
  fact: Type.String(),
  fix: Type.Optional(Type.String()),
});
export type ArgumentIssue = Static<typeof argumentIssueSchema>;
export const causeSchema = object({
  name: Type.String(),
  message: Type.String(),
  code: Type.Optional(Type.String()),
  // A bounded flat sequence preserves nesting with depth, including AggregateError branches.
  depth: count,
  branch: Type.Optional(count),
  omitted: optionalCount,
});
export type CauseFact = Static<typeof causeSchema>;
export const searchDiagnosticSchema = Type.Union([
  object({
    kind: Type.Literal("process"),
    code: Type.Union([Type.Integer(), Type.Null()]),
    stderr: Type.String(),
    omittedBytes: optionalCount,
  }),
  object({
    kind: Type.Literal("file"),
    path: Type.String(),
    causes: Type.Array(causeSchema),
    omittedCauses: optionalCount,
  }),
]);
export type SearchDiagnostic = Static<typeof searchDiagnosticSchema>;
export const searchDiagnosticsSchema = object({
  entries: Type.Array(searchDiagnosticSchema),
  omittedEntries: count,
  maxBytes: count,
});
export type SearchDiagnostics = Static<typeof searchDiagnosticsSchema>;
const definition = <F extends TSchema, R extends TSchema>(
  facts: F,
  recovery: R,
  next: string,
  description: string,
  overrides: Partial<Record<Extract<Static<R>, string>, string>> = {},
) => ({ facts, recovery, next, description, overrides });
const none = Type.Never();
export const errorDefinitions = {
  INVALID_ARGUMENTS: definition(
    object({
      executed: Type.Literal(false),
      issues: Type.Array(argumentIssueSchema),
      arguments: Type.Optional(Type.Unknown()),
      argumentsOmitted: Type.Optional(Type.Literal(true)),
      schemaLimited: Type.Optional(Type.Literal(true)),
      omittedIssues: optionalCount,
    }),
    none,
    "Correct the reported fields and submit the complete call.",
    "Arguments fail preparation, schema validation, or semantic checks.",
  ),
  OPERATION_ABORTED: definition(empty, none, "", "The call was cancelled."),
  PATH_NOT_FOUND: definition(
    empty,
    choices(["create", "glob"] as const),
    "Check the path.",
    "Only ENOENT or overwrite of a missing target.",
    {
      create: 'Use mode "create" to create a new file.',
      glob: "Use an existing directory as path and a filename wildcard as glob.",
    },
  ),
  FILESYSTEM_ERROR: definition(empty, none, "", "A filesystem operation failed."),
  FILE_CHANGED: definition(
    empty,
    none,
    "Retry the call.",
    "A read, search, or pre-publication revision changed.",
  ),
  UNSUPPORTED_ENCODING: definition(empty, none, "", "Confirmed malformed UTF-8."),
  UNSUPPORTED_TEXT: definition(empty, none, "", "Text contains NUL."),
  INVALID_UNICODE: definition(empty, none, "", "Content cannot be encoded losslessly as UTF-8."),
  ANCHOR_MISMATCH: definition(
    object({
      failures: Type.Array(anchorFailureSchema),
      omittedFailures: optionalCount,
      ...matched,
      candidateNeighborhoods: Type.Optional(Type.Array(neighborhoodSchema)),
      omittedNeighborhoodRows: optionalCount,
    }),
    none,
    "Before reusing a candidate or observed anchor, confirm it is the intended target; use read or grep for omitted rows, out-of-range lines, or more context. Retries verify every anchor again.",
    "Edit anchors do not match the snapshot.",
  ),
  INVALID_RANGE: definition(
    object(matched),
    none,
    "",
    "An edit range or move destination is invalid.",
  ),
  OVERLAPPING_EDITS: definition(
    object(matched),
    none,
    "Merge overlapping edits into one edit per range.",
    "Edit mutations overlap.",
  ),
  NO_MATCH: definition(
    object({ rule: count, find: Type.String(), regex: Type.Boolean() }),
    none,
    "Verify the target text with read or grep; check case sensitivity or regex flags if applicable.",
    "A replace rule has no matches.",
  ),
  OVERLAPPING_MATCHES: definition(
    object({ rules: Type.Array(count), offset: count }),
    none,
    "",
    "Replace match ranges overlap.",
  ),
  REGEX_TIMEOUT: definition(
    object({ timeoutMs: count }),
    none,
    "",
    "Regex evaluation exceeded its timeout.",
  ),
  REGEX_WORKER_FAILED: definition(empty, none, "", "The regex worker failed."),
  TARGET_EXISTS: definition(
    empty,
    Type.Literal("overwrite"),
    'Use mode "overwrite" to replace the existing file.',
    "Create mode names an existing target.",
  ),
  NOT_REGULAR_FILE: definition(empty, none, "", "The target is not a regular file."),
  MULTIPLE_HARD_LINKS: definition(empty, none, "", "The target has multiple hard links."),
  SYMLINK_UNRESOLVED: definition(empty, none, "", "The symlink target cannot be resolved."),
  PUBLISH_FAILED: definition(empty, none, "", "Publication failed or is uncertain."),
  POST_PROCESS_FAILED: definition(empty, none, "", "A post-publication step failed."),
  INVALID_REGEX: definition(
    empty,
    choices(["literal", "dialect"] as const),
    "Set literal to true to search the text exactly.",
    "Ripgrep rejected a regex.",
    {
      dialect:
        "Rewrite the pattern without lookaround or backreferences, or use replace for a JavaScript regex within one file.",
    },
  ),
  SEARCH_INCOMPLETE: definition(
    object({ diagnostics: searchDiagnosticsSchema }),
    none,
    "",
    "No confirmed search output is available.",
  ),
  RIPGREP_FAILED: definition(empty, none, "", "Ripgrep failed or returned unusable output."),
  UNSUPPORTED_PATH: definition(empty, none, "", "A search path is not valid UTF-8."),
  NOT_FORGETTABLE: definition(
    object({ ids: strings, available: strings, omittedAvailable: optionalCount }),
    none,
    "",
    "Ids are not eligible results of the preceding step.",
  ),
  UNCLASSIFIED: definition(empty, none, "", "An unclassified external failure."),
} as const;
export type ErrorCode = keyof typeof errorDefinitions;
export type ErrorFacts<C extends ErrorCode> = {
  [K in ErrorCode]: keyof Static<(typeof errorDefinitions)[K]["facts"]> extends never
    ? Readonly<Record<string, never>>
    : Static<(typeof errorDefinitions)[K]["facts"]>;
}[C];
export type Recovery<C extends ErrorCode> = Static<(typeof errorDefinitions)[C]["recovery"]>;
export type ErrorOptions<C extends ErrorCode> = {
  cause?: unknown;
  facts?: ErrorFacts<C>;
  recovery?: Recovery<C>;
};
export const ERROR_CODES = Object.keys(errorDefinitions) as ErrorCode[];
function descriptorSchema<C extends ErrorCode>(code: C) {
  return object({
    code: Type.Literal(code),
    message: Type.String(),
    facts: errorDefinitions[code].facts,
    recovery: Type.Optional(errorDefinitions[code].recovery),
  });
}
// Object.fromEntries loses the relationship between each key and its schema; restore that mapped type here.
const descriptors = object(
  Object.fromEntries(ERROR_CODES.map((code) => [code, descriptorSchema(code)])) as {
    [C in ErrorCode]: ReturnType<typeof descriptorSchema<C>>;
  },
);
export const errorDescriptorSchema = Type.Index(descriptors, Type.KeyOf(descriptors));
export type ErrorDescriptor = Static<typeof errorDescriptorSchema>;

export const mutationSchema = object({
  publication: choices(["NOT_PUBLISHED", "PUBLISHED", "UNKNOWN"] as const),
  stage: choices(["prepare", "commit", "post_process"] as const),
  created: Type.Optional(Type.Boolean()),
  baseRevision: Type.Optional(Type.String()),
  publishedRevision: Type.Optional(Type.String()),
  observedRevision: Type.Optional(Type.String()),
  freshness: Type.Optional(choices(["unchanged", "changed", "missing", "unknown"] as const)),
  observationCauses: Type.Optional(Type.Array(causeSchema)),
});
export type MutationFact = Static<typeof mutationSchema>;
export const commandSchema = object({
  status: choices([
    "not_requested",
    "waiting",
    "running",
    "skipped",
    "succeeded",
    "failed",
    "timeout",
    "cancelled",
  ] as const),
  blockedBy: Type.Optional(choices(["mutation", "target", "cancellation", "revision"] as const)),
  output: Type.String(),
  causes: Type.Optional(Type.Array(causeSchema)),
  terminate: Type.Optional(Type.Boolean()),
});
export type CommandFact = Static<typeof commandSchema>;
export const anchorsSchema = object({ rows: Type.String(), omitted: count, maxBytes: count });
export type AnchorReport = Static<typeof anchorsSchema>;
export const readSchema = object({
  start: count,
  end: count,
  totalLines: count,
  finalNewline: Type.Boolean(),
  nextOffset: Type.Optional(count),
  truncated: Type.Boolean(),
  maxBytes: count,
  omittedRows: count,
  oversizedLine: Type.Optional(count),
  native: Type.Literal(false),
});
export type ReadFact = Static<typeof readSchema>;
const nativeReadSchema = object({
  native: Type.Literal(true),
  nextOffset: Type.Optional(Type.Never()),
  oversizedLine: Type.Optional(Type.Never()),
});
export const searchSchema = object({
  mode: choices(["content", "files", "count"] as const),
  incomplete: Type.Boolean(),
  diagnostics: searchDiagnosticsSchema,
  limit: count,
  limitReached: Type.Boolean(),
  byteLimit: count,
  omittedRows: count,
  previewUnits: count,
  partialRows: count,
  invalidUtf8Paths: strings,
});
export type SearchFact = Static<typeof searchSchema>;
const reportFields = {
  version: Type.Literal(1),
  tool: choices(["read", "grep", "edit", "replace", "write", "forget"] as const),
  path: Type.Optional(Type.Union([Type.String(), strings])),
  payload: strings,
  causes: Type.Optional(Type.Array(causeSchema)),
  mutation: Type.Optional(mutationSchema),
  command: Type.Optional(commandSchema),
  anchors: Type.Optional(anchorsSchema),
  read: Type.Optional(Type.Union([readSchema, nativeReadSchema])),
  search: Type.Optional(searchSchema),
  edit: Type.Optional(object({ operations: count })),
  replace: Type.Optional(object({ matches: count })),
  forget: Type.Optional(object({ ids: strings })),
  progressFailures: Type.Optional(Type.Array(causeSchema)),
};
export const reportSchema = Type.Union([
  object({ ...reportFields, outcome: Type.Literal("success"), error: Type.Optional(Type.Never()) }),
  object({ ...reportFields, outcome: Type.Literal("failure"), error: errorDescriptorSchema }),
]);
export type ToolReport = Static<typeof reportSchema>;
export type ToolName = ToolReport["tool"];
export type SuccessReport = Extract<ToolReport, { outcome: "success" }>;
export type FailureReport = Extract<ToolReport, { outcome: "failure" }>;
