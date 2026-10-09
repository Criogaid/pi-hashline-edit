/**
 * The single definition of the tool report: every fact a tool result can state,
 * in the order the model reads it, each error code with its facts and recovery,
 * and the recovery that follows from a successful result's facts.
 *
 * One report describes every result of every tool, success or failure. A
 * failure report is the entire result; a success report follows the tool's
 * content payload (read rows, grep rows, updated anchors). Each field has one
 * owning layer (README "Reports"), so no fact can be stated twice. report.ts
 * renders a report for the model; render.ts renders the same object for the TUI.
 *
 * Types derive from these schemas. src/core imports only types from this module,
 * so the regex worker, which runs core without Pi's loader, never loads TypeBox.
 *
 * @module pi-hashline-edit/pi
 */

import { Type, type Static, type TObject, type TProperties } from "typebox";

const count = (description: string) => Type.Integer({ minimum: 1, description });
const opt = Type.Optional;

/** A failure reported beneath the step that failed: our code or Node's errno, its own message, and its causes. */
export const CAUSE_SCHEMA = Type.Cyclic(
  {
    Cause: Type.Object({
      error: Type.Optional(Type.String({ description: "Error code of a classified cause." })),
      code: Type.Optional(Type.String({ description: "Node errno code, such as EACCES." })),
      message: Type.String(),
      cause: Type.Optional(Type.Ref("Cause")),
      errors: Type.Optional(Type.Array(Type.Ref("Cause"))),
    }),
  },
  "Cause",
);
export type Cause = Static<typeof CAUSE_SCHEMA>;

export const PUBLICATION_SCHEMA = Type.Union([
  Type.Literal("NOT_PUBLISHED"),
  Type.Literal("PUBLISHED"),
  Type.Literal("UNKNOWN"),
]);
export type PublicationStatus = Static<typeof PUBLICATION_SCHEMA>;

export const STAGE_SCHEMA = Type.Union([
  Type.Literal("prepare"),
  Type.Literal("commit"),
  Type.Literal("post_process"),
]);
export type MutationStage = Static<typeof STAGE_SCHEMA>;

export const FRESHNESS_SCHEMA = Type.Union([
  Type.Literal("unchanged"),
  Type.Literal("changed"),
  Type.Literal("missing"),
  Type.Literal("unknown"),
]);
export type Freshness = Static<typeof FRESHNESS_SCHEMA>;

/** A then_run command's final status; `skipped` never started, `cancelled` may have. */
export const COMMAND_STATUS_SCHEMA = Type.Union([
  Type.Literal("succeeded"),
  Type.Literal("failed"),
  Type.Literal("timeout"),
  Type.Literal("cancelled"),
  Type.Literal("skipped"),
]);
export type CommandStatus = Static<typeof COMMAND_STATUS_SCHEMA>;

const ANCHOR_FAILURE_SCHEMA = Type.Object({
  field: Type.String(),
  op: Type.String(),
  cited: Type.String(),
  result: Type.Union([
    Type.Literal("shifted"),
    Type.Literal("ambiguous"),
    Type.Literal("unresolved"),
  ]),
  search: opt(Type.Union([Type.Literal("local window"), Type.Literal("full file")])),
  candidate: opt(Type.String()),
  content: opt(Type.String()),
  contentOmitted: opt(Type.String()),
  candidates: opt(Type.Array(Type.String())),
  omittedCandidates: opt(Type.Integer({ minimum: 1 })),
  observed: opt(Type.String()),
  observedOmitted: opt(Type.String()),
});
export type AnchorFailureFact = Static<typeof ANCHOR_FAILURE_SCHEMA>;

export const ARGUMENT_ISSUE_SCHEMA = Type.Object({
  field: Type.String({
    description: "Path of the field in Pi's prepared arguments; `$` for none.",
  }),
  reason: Type.String({ description: "What is wrong with the value; facts only." }),
  fix: opt(Type.String({ description: "How to correct it, when the reason alone does not say." })),
});
export type ArgumentIssue = Static<typeof ARGUMENT_ISSUE_SCHEMA>;

/**
 * Every fact a report can carry beside the envelope, in output order: failure
 * facts first, then each tool's outcome, freshness, the command, and forget.
 */
export const FACT_FIELDS = {
  // Argument rejection (argument-error.ts).
  issues: Type.Array(ARGUMENT_ISSUE_SCHEMA),
  omittedIssues: count("Issues omitted from the byte budget."),
  schemaLimited: Type.Literal(true, {
    description: "A native diagnostic allowance was reached; more issues may exist.",
  }),
  arguments: Type.Unknown({ description: "Pi's prepared arguments." }),
  argumentsOmitted: Type.Literal(true, { description: "The argument copy did not fit or encode." }),
  // A missing path among several (grep).
  missing: Type.String(),
  // Anchor verification (failure-context.ts).
  failures: Type.Array(ANCHOR_FAILURE_SCHEMA),
  omittedFailures: count("Failures omitted from the byte budget."),
  matched: Type.Array(Type.String()),
  omittedMatched: count("Matched anchors omitted from the byte budget."),
  candidateNeighborhoods: Type.Array(
    Type.Object({ lines: Type.String(), rows: Type.Array(Type.String()) }),
  ),
  omittedNeighborhoodRows: count("Neighborhood rows omitted from the byte budget."),
  // Replacement rules (core/replace.ts, replace-regex.ts).
  rule: Type.Integer({ minimum: 0 }),
  rules: Type.Array(Type.Integer({ minimum: 0 })),
  offset: Type.Integer({ minimum: 0 }),
  timeoutMs: Type.Integer({ minimum: 1 }),
  exitCode: Type.Union([Type.Integer(), Type.Null()]),
  // forget rejection.
  ids: Type.Array(Type.String()),
  available: Type.Array(Type.String()),
  omittedAvailable: count("Available ids omitted from the byte budget."),
  // read outcome.
  pagination: Type.Object({
    start: Type.Integer(),
    end: Type.Integer(),
    totalLines: Type.Integer(),
    nextOffset: Type.Integer(),
  }),
  truncatedAt: Type.String({ description: "The byte budget that stopped the output." }),
  lineTooLong: Type.Object({ line: Type.Integer(), limit: Type.String() }),
  // grep outcome; `matches` is also replace's match count.
  matches: Type.Integer({ minimum: 0 }),
  files: Type.Integer({ minimum: 0 }),
  matchLimit: Type.Integer({ minimum: 1, description: "The match limit that stopped the search." }),
  outputLimit: Type.String({ description: "Pi's output byte limit that cut the result." }),
  linePreviewLimit: Type.Integer({ description: "UTF-16 units kept in a cut line preview." }),
  invalidUtf8: Type.Array(Type.String(), {
    description: "Files shown as plain previews; their rows are not edit anchors.",
  }),
  diagnostics: Type.String({ description: "Search diagnostics; results cover confirmed matches." }),
  // Mutation outcome.
  created: Type.Literal(true),
  omittedAnchors: count("Changed positions omitted from the anchor budget."),
  // Commit-layer observation after publication.
  freshness: FRESHNESS_SCHEMA,
  freshnessError: CAUSE_SCHEMA,
  // Action Fusion.
  then_run: Type.Object({ status: COMMAND_STATUS_SCHEMA, output: opt(Type.String()) }),
  progressError: CAUSE_SCHEMA,
  // forget.
  forgotten: Type.Array(Type.String()),
  resultId: Type.String({ description: "Id to pass to forget." }),
  forgetScope: Type.String(),
  contentForgotten: Type.Literal(true),
} satisfies TProperties;

type FactName = keyof typeof FACT_FIELDS;

/** Facts of one code: the named fields, each optional unless listed as required. */
function facts<const R extends FactName, const O extends FactName = never>(
  required: readonly R[],
  optional: readonly O[] = [],
) {
  const properties = {} as Record<string, unknown>;
  for (const name of required) properties[name] = FACT_FIELDS[name];
  for (const name of optional) properties[name] = Type.Optional(FACT_FIELDS[name]);
  return Type.Object(
    properties as { [K in R]: (typeof FACT_FIELDS)[K] } & {
      [K in O]: ReturnType<typeof Type.Optional<(typeof FACT_FIELDS)[K]>>;
    },
  );
}
const NONE = facts([]);
const MATCHED = ["matched", "omittedMatched"] as const;

/**
 * Each error code: its facts and its recovery. `next.default` is the code's
 * recovery; other keys are the only alternatives a throw site may select.
 * Once a mutation reached or may have reached the file, PUBLICATION_NEXT replaces them.
 */
export const ERROR_DEFINITIONS = {
  INVALID_ARGUMENTS: {
    facts: facts(["issues"], ["omittedIssues", "schemaLimited", "arguments", "argumentsOmitted"]),
  },
  OPERATION_ABORTED: { facts: NONE },
  PATH_NOT_FOUND: {
    facts: facts([], ["missing"]),
    next: {
      default: "Check the path.",
      useCreate: 'Use mode "create" to create a new file.',
      useGlob: "Use an existing directory as path and a filename wildcard as glob.",
    },
  },
  FILESYSTEM_ERROR: { facts: NONE },
  FILE_CHANGED: {
    facts: NONE,
    next: { default: "Retry the call." },
  },
  UNSUPPORTED_ENCODING: { facts: NONE },
  UNSUPPORTED_TEXT: { facts: NONE },
  INVALID_UNICODE: {
    facts: NONE,
  },
  ANCHOR_MISMATCH: {
    facts: facts(
      ["failures"],
      ["omittedFailures", ...MATCHED, "candidateNeighborhoods", "omittedNeighborhoodRows"],
    ),
    next: {
      default:
        "Before reusing a candidate or observed anchor, confirm it is the intended target; use read or grep for omitted rows, out-of-range lines, or more context. Retries verify every anchor again.",
    },
  },
  INVALID_RANGE: {
    facts: facts([], MATCHED),
  },
  OVERLAPPING_EDITS: {
    facts: facts([], MATCHED),
    next: { default: "Merge overlapping edits into one edit per range." },
  },
  NO_MATCH: {
    facts: facts(["rule"]),
    next: {
      default:
        "Verify the target text with read or grep; check case sensitivity or regex flags if applicable.",
    },
  },
  OVERLAPPING_MATCHES: {
    facts: facts(["rules", "offset"]),
  },
  REGEX_TIMEOUT: {
    facts: facts(["timeoutMs"]),
  },
  REGEX_WORKER_FAILED: {
    facts: facts([], ["exitCode"]),
  },
  TARGET_EXISTS: {
    facts: NONE,
    next: { default: 'Use mode "overwrite" to replace the existing file.' },
  },
  NOT_REGULAR_FILE: { facts: NONE },
  MULTIPLE_HARD_LINKS: { facts: NONE },
  SYMLINK_UNRESOLVED: { facts: NONE },
  PUBLISH_FAILED: {
    facts: NONE,
  },
  POST_PROCESS_FAILED: {
    facts: NONE,
  },
  INVALID_REGEX: {
    facts: NONE,
    next: {
      default: "Set literal to true to search the text exactly.",
      rewriteDialect:
        "Rewrite the pattern without lookaround or backreferences, or use replace for a JavaScript regex within one file.",
    },
  },
  SEARCH_INCOMPLETE: {
    facts: facts(["diagnostics"]),
  },
  RIPGREP_FAILED: {
    facts: facts([], ["exitCode"]),
  },
  UNSUPPORTED_PATH: {
    facts: NONE,
  },
  NOT_FORGETTABLE: {
    facts: facts(["ids", "available"], ["omittedAvailable"]),
  },
  UNCLASSIFIED: { facts: NONE },
} as const satisfies Record<
  string,
  { facts: TObject; next?: { default: string } & Record<string, string> }
>;

type Definitions = typeof ERROR_DEFINITIONS;
export type ErrorCode = keyof Definitions;
export const ERROR_CODES = Object.keys(ERROR_DEFINITIONS) as ErrorCode[];
/** The facts a failure of `code` carries. */
export type ErrorFacts<C extends ErrorCode> = Static<Definitions[C]["facts"]>;
/** Recovery alternatives a throw site may select for `code`. */
export type NextVariant<C extends ErrorCode> = Definitions[C] extends {
  next: infer N;
}
  ? Exclude<keyof N, "default">
  : never;

/** Text shared by success and failure: a file whose current anchors are unknown must be read first. */
export const REREAD = "Read the file before further edits.";

/** Once a mutation reached or may have reached the file, a retry could apply it twice. */
export const PUBLICATION_NEXT = {
  PUBLISHED: `The change is saved; do not repeat it. ${REREAD}`,
  UNKNOWN: `The change may already be applied; do not repeat it. ${REREAD}`,
} as const satisfies Record<Exclude<PublicationStatus, "NOT_PUBLISHED">, string>;

/**
 * Recovery after a successful result, by the first fact present in this order.
 * A fact absent from this list needs no recovery beyond itself.
 */
export const OUTCOME_NEXT = [
  ["freshness", REREAD],
  ["omittedAnchors", "Read the file for the omitted anchor positions."],
  [
    "lineTooLong",
    "Inspect the line in chunks with bash, or use replace for a known literal or regex change; a smaller limit cannot split a line.",
  ],
  ["pagination", "Continue with offset set to pagination.nextOffset."],
  ["matchLimit", "Raise limit or refine the pattern for more matches."],
  ["outputLimit", "Narrow path, glob, or pattern to see the omitted output."],
  ["linePreviewLimit", "Read the full line before rewriting it from a partial preview."],
  ["contentForgotten", "Rerun the call to see it again."],
] as const satisfies readonly (readonly [FactName, string])[];

/** The report envelope and facts, in output order; `next` is always last. */
export const REPORT_SCHEMA = Type.Object({
  error: opt(Type.Union(ERROR_CODES.map((code) => Type.Literal(code)))),
  tool: Type.String(),
  path: opt(Type.Union([Type.String(), Type.Array(Type.String())])),
  publication: opt(PUBLICATION_SCHEMA),
  stage: opt(STAGE_SCHEMA),
  message: opt(Type.String()),
  cause: opt(CAUSE_SCHEMA),
  ...(Object.fromEntries(
    Object.entries(FACT_FIELDS).map(([name, schema]) => [name, Type.Optional(schema)]),
  ) as { [K in FactName]: ReturnType<typeof Type.Optional<(typeof FACT_FIELDS)[K]>> }),
  next: opt(Type.String()),
});
export type Report = Omit<Static<typeof REPORT_SCHEMA>, "error"> & { error?: ErrorCode };
