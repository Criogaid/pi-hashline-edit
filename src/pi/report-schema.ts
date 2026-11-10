/**
 * The single definition of the tool report: every fact a tool result can state,
 * in the order the model reads it, each error code with its facts and recovery,
 * and the recovery that follows from a successful result's facts.
 *
 * One report describes every result of every tool, success or failure. A
 * failure report is the entire result; a success report follows the tool's
 * content payload (read rows, grep rows). Each field has one
 * owning layer, so no fact can be stated twice. report.ts
 * omits the call's tool and path from result text; render.ts uses the full report for the TUI.
 *
 * Types derive from these schemas. src/core imports only types from this module,
 * so engines stay independent of Pi. Workers do not load TypeBox; the host validates their replies.
 *
 * @module pi-hashline-edit/pi
 */

import { Type, type Static, type TObject, type TProperties, type TSchema } from "typebox";

const count = (description: string) => Type.Integer({ minimum: 1, description });
const opt = Type.Optional;

/** A failure reported beneath the step that failed: our code or Node's errno, its own message, and its causes. */
export const CAUSE_SCHEMA = Type.Cyclic(
  {
    Cause: Type.Object(
      {
        error: opt(Type.String({ description: "Error code of a classified cause." })),
        code: opt(Type.String({ description: "Node errno code, such as EACCES." })),
        message: Type.String(),
        cause: opt(Type.Ref("Cause")),
      },
      { additionalProperties: false },
    ),
  },
  "Cause",
);
export type Cause = Static<typeof CAUSE_SCHEMA>;

const PUBLICATION_SCHEMA = Type.Union([
  Type.Literal("NOT_PUBLISHED"),
  Type.Literal("PUBLISHED"),
  Type.Literal("UNKNOWN"),
]);
export type PublicationStatus = Static<typeof PUBLICATION_SCHEMA>;

const FRESHNESS_SCHEMA = Type.Union([
  Type.Literal("unchanged"),
  Type.Literal("changed"),
  Type.Literal("missing"),
  Type.Literal("unknown"),
]);
export type Freshness = Static<typeof FRESHNESS_SCHEMA>;

/** A then_run command's final status; `skipped` never started, `cancelled` may have. */
const COMMAND_STATUS_SCHEMA = Type.Union([
  Type.Literal("succeeded"),
  Type.Literal("failed"),
  Type.Literal("timeout"),
  Type.Literal("cancelled"),
  Type.Literal("skipped"),
]);
export type CommandStatus = Static<typeof COMMAND_STATUS_SCHEMA>;

/** A then_run command's session tool result, as the TUI renders it. */
const COMMAND_RESULT_SCHEMA = Type.Object(
  {
    content: Type.Array(
      Type.Union([
        Type.Object(
          {
            type: Type.Literal("text"),
            text: Type.String(),
            textSignature: opt(Type.String()),
          },
          { additionalProperties: false },
        ),
        Type.Object(
          { type: Type.Literal("image"), data: Type.String(), mimeType: Type.String() },
          { additionalProperties: false },
        ),
      ]),
    ),
    details: opt(Type.Unknown()),
  },
  { additionalProperties: false },
);
export type CommandResult = Static<typeof COMMAND_RESULT_SCHEMA>;

/** Fusion updates cross RPC and transcript boundaries before a final tool report exists. */
export const ACTION_FUSION_PROGRESS_SCHEMA = Type.Object(
  {
    toolCallId: Type.String(),
    commandText: Type.String(),
    command: Type.Union([COMMAND_STATUS_SCHEMA, Type.Literal("waiting"), Type.Literal("running")]),
    freshness: FRESHNESS_SCHEMA,
    result: opt(COMMAND_RESULT_SCHEMA),
    mutationCompleted: Type.Boolean(),
    timing: opt(
      Type.Object(
        {
          timeoutSeconds: Type.Number({ exclusiveMinimum: 0 }),
          remainingSeconds: Type.Integer({ minimum: 0 }),
        },
        { additionalProperties: false },
      ),
    ),
  },
  { additionalProperties: false },
);
export type ActionFusionProgress = Static<typeof ACTION_FUSION_PROGRESS_SCHEMA>;

const ANCHOR_FAILURE_SCHEMA = Type.Object(
  {
    field: Type.String(),
    action: Type.String(),
    cited: Type.String(),
    result: Type.Union([
      Type.Literal("shifted"),
      Type.Literal("ambiguous"),
      Type.Literal("unresolved"),
    ]),
    candidate: opt(Type.String()),
    content: opt(Type.String()),
    candidates: opt(Type.Array(Type.String())),
    omittedCandidates: opt(Type.Integer({ minimum: 1 })),
    observed: opt(Type.String()),
    notShown: opt(
      Type.String({ description: "Why content (shifted) or observed (unresolved) is absent." }),
    ),
  },
  { additionalProperties: false },
);
export type AnchorFailureFact = Static<typeof ANCHOR_FAILURE_SCHEMA>;

const ARGUMENT_ISSUE_SCHEMA = Type.Object(
  {
    field: Type.String({
      description: "Path of the field in Pi's prepared arguments; `$` for none.",
    }),
    reason: Type.String({ description: "What is wrong with the value; facts only." }),
    fix: opt(
      Type.String({ description: "How to correct it, when the reason alone does not say." }),
    ),
  },
  { additionalProperties: false },
);
export type ArgumentIssue = Static<typeof ARGUMENT_ISSUE_SCHEMA>;

/**
 * Every fact carries its schema and its audience contract here. Model-visible
 * facts must also state the decision their value changes; TUI-only facts omit it.
 */
type FactAudience = "model" | "tui";
type FactDefinition<T extends TSchema = TSchema> = {
  schema: T;
  audience: FactAudience;
  decision?: string;
};

function modelFact<T extends TSchema>(schema: T, decision: string): FactDefinition<T> {
  if (decision.trim().length === 0) throw new Error("Model facts require a decision statement.");
  return { schema, audience: "model", decision };
}

function tuiFact<T extends TSchema>(schema: T): FactDefinition<T> {
  return { schema, audience: "tui" };
}

/**
 * Every fact a report can carry beside the envelope, in output order: failure
 * facts first, then each tool's outcome, freshness, and the command.
 */
const FACT_FIELDS = {
  // Argument rejection (argument-error.ts).
  issues: modelFact(
    Type.Array(ARGUMENT_ISSUE_SCHEMA),
    "Correct the reported argument issues before retrying.",
  ),
  omittedIssues: modelFact(
    count("Issues omitted from the byte budget."),
    "Know that the bounded argument report is incomplete.",
  ),
  schemaLimited: modelFact(
    Type.Literal(true, {
      description: "A native diagnostic allowance was reached; more issues may exist.",
    }),
    "Know that native validation may have omitted additional issues.",
  ),
  missing: modelFact(
    Type.Array(Type.String(), {
      description: "Resolved paths that do not exist; shows where a relative path led.",
    }),
    "Use the resolved missing paths to correct the target or choose create mode.",
  ),

  // Anchor verification (failure-context.ts).
  failures: modelFact(
    Type.Array(ANCHOR_FAILURE_SCHEMA),
    "Choose a verified anchor or reread before retrying.",
  ),
  omittedFailures: modelFact(
    count("Failures omitted from the byte budget."),
    "Know that anchor evidence is incomplete.",
  ),
  candidateNeighborhoods: modelFact(
    Type.Array(
      Type.Object(
        { lines: Type.String(), rows: Type.Array(Type.String()) },
        { additionalProperties: false },
      ),
    ),
    "Inspect the observed neighborhoods before selecting an ambiguous anchor.",
  ),
  omittedNeighborhoodRows: modelFact(
    count("Neighborhood rows omitted from the byte budget."),
    "Know that candidate context is incomplete.",
  ),

  // Overlap (core/apply.ts, core/replace.ts).
  conflict: modelFact(
    Type.Array(Type.String(), {
      description: "The first conflicting pair of inputs found; more conflicts may exist.",
    }),
    "Merge or separate the conflicting edits or rules before retrying.",
  ),

  // Replacement rules (core/replace.ts).
  unmatched: modelFact(
    Type.Array(Type.String(), { description: "Rules that match nothing." }),
    "Correct the target rules using read or grep before retrying.",
  ),
  line: modelFact(
    Type.Integer({ minimum: 1, description: "Line where the conflicting match starts." }),
    "Locate the first conflicting match when correcting the request.",
  ),

  // Regex workers (regex-worker.ts).
  timeoutMs: modelFact(
    Type.Integer({ minimum: 1 }),
    "Narrow or simplify the timed-out pattern before retrying.",
  ),
  exitCode: tuiFact(Type.Union([Type.Integer(), Type.Null()])),

  // read outcome; outputLimit below is shared with grep.
  pagination: modelFact(
    Type.Object(
      {
        start: Type.Integer(),
        end: Type.Integer(),
        totalLines: Type.Integer(),
        nextOffset: Type.Integer(),
      },
      { additionalProperties: false },
    ),
    "Use pagination.nextOffset to continue reading.",
  ),
  lineTooLong: modelFact(
    Type.Object({ line: Type.Integer(), limit: Type.String() }, { additionalProperties: false }),
    "Inspect the oversized line with an appropriate tool before editing it.",
  ),

  // grep outcome; matches is also replace's match count.
  matches: modelFact(
    Type.Integer({ minimum: 0 }),
    "Use the match count to decide whether more search or replacement work is needed.",
  ),
  files: modelFact(
    Type.Integer({ minimum: 0 }),
    "Use the file count to decide whether the search scope is appropriate.",
  ),
  scanned: tuiFact(
    Type.Union([Type.Literal("files"), Type.Literal("all")], {
      description:
        "Without line candidates, the files searched whole: those containing text every match needs, or every file in scope.",
    }),
  ),
  matchLimit: modelFact(
    Type.Integer({ minimum: 1, description: "The match limit that stopped the search." }),
    "Raise the limit when more matches are needed.",
  ),
  scanLimit: modelFact(
    Type.String({
      description:
        "Bytes of files read when every file was a candidate; later files were not searched.",
    }),
    "Narrow the search or add text every match must contain to search the remaining files.",
  ),
  outputLimit: modelFact(
    Type.String({ description: "The output byte budget that cut the result." }),
    "Narrow the scope to see omitted output.",
  ),
  linePreviewLimit: modelFact(
    Type.Integer({ description: "UTF-16 units kept in a cut line preview." }),
    "Read the full line before rewriting it from a partial preview.",
  ),
  invalidUtf8: modelFact(
    Type.Array(Type.String(), {
      description: "Files shown as plain previews; their rows are not edit anchors.",
    }),
    "Do not use malformed preview rows as edit anchors.",
  ),
  diagnostics: modelFact(
    Type.String({ description: "Search diagnostics; results cover confirmed matches." }),
    "Account for the diagnostics before relying on the search result.",
  ),
  literalPipe: modelFact(
    Type.Literal(true, {
      description: "A literal pattern contains |, which matches only the | character.",
    }),
    "Separate pattern alternatives or keep the pattern literal.",
  ),

  // Mutation outcome.
  created: tuiFact(Type.Literal(true)),

  // Commit-layer observation after publication.
  freshness: modelFact(
    FRESHNESS_SCHEMA,
    "Read the file before further edits when the current content is not known to be unchanged.",
  ),
  freshnessError: modelFact(
    CAUSE_SCHEMA,
    "Use the freshness recovery instruction when the post-commit observation failed.",
  ),

  // Action Fusion.
  then_run: modelFact(
    Type.Object(
      { status: COMMAND_STATUS_SCHEMA, output: opt(Type.String()) },
      { additionalProperties: false },
    ),
    "Use the command status and output to decide whether a follow-up action is needed.",
  ),
  progressError: tuiFact(CAUSE_SCHEMA),
} as const satisfies Record<string, FactDefinition>;

type FactName = keyof typeof FACT_FIELDS;
type FactSchema<Name extends FactName> = (typeof FACT_FIELDS)[Name]["schema"];
type TuiOnlyFactName = {
  [Name in FactName]: (typeof FACT_FIELDS)[Name]["audience"] extends "tui" ? Name : never;
}[FactName];
export type ModelOmittedField = "tool" | "path" | TuiOnlyFactName;

/** Fields whose values are kept for TUI/host but omitted from model text. */
export const MODEL_OMITTED_FIELDS: ReadonlySet<ModelOmittedField> = new Set<ModelOmittedField>([
  "tool",
  "path",
  ...Object.entries(FACT_FIELDS)
    .filter(([, definition]) => definition.audience === "tui")
    .map(([name]) => name as TuiOnlyFactName),
]);

/** Facts of one code: the named fields, each optional unless listed as required. */
function facts<const R extends readonly FactName[], const O extends readonly FactName[] = []>(
  required: R,
  optional?: O,
) {
  const properties: TProperties = {};
  for (const name of required) properties[name] = FACT_FIELDS[name].schema;
  for (const name of optional ?? []) properties[name] = opt(FACT_FIELDS[name].schema);
  // A single mapped property set preserves required keys in TypeBox's static inference.
  return Type.Object(
    properties as {
      [K in R[number] | O[number]]: K extends R[number]
        ? FactSchema<K>
        : ReturnType<typeof Type.Optional<FactSchema<K>>>;
    },
    { additionalProperties: false },
  );
}
const NONE = facts([]);

/**
 * Each error code: its facts and its recovery. `next.default` is the code's
 * recovery; other keys are the only alternatives a throw site may select.
 * Once a mutation reached or may have reached the file, PUBLICATION_NEXT replaces them.
 */
export const ERROR_DEFINITIONS = {
  INVALID_ARGUMENTS: { facts: facts(["issues"], ["omittedIssues", "schemaLimited"]) },
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
  INVALID_UNICODE: { facts: NONE },
  ANCHOR_MISMATCH: {
    facts: facts(
      ["failures"],
      ["omittedFailures", "candidateNeighborhoods", "omittedNeighborhoodRows"],
    ),
    next: {
      default:
        "Confirm a candidate or observed anchor is the intended target before reusing it; otherwise use read or grep.",
    },
  },
  OVERLAPPING_EDITS: {
    facts: facts(["conflict"]),
    next: {
      default: "Merge them into one edit per range or position.",
    },
  },
  NO_MATCH: {
    facts: facts(["unmatched"]),
    next: {
      default:
        "Verify the target text with read or grep; check case sensitivity or regex flags if applicable.",
    },
  },
  OVERLAPPING_MATCHES: {
    facts: facts(["conflict", "line"]),
    next: {
      default:
        "Change the conflicting rules so their matches do not overlap, or merge them into one rule.",
    },
  },
  REGEX_TIMEOUT: { facts: facts(["timeoutMs"]) },
  REGEX_WORKER_FAILED: { facts: facts([], ["exitCode"]) },
  TARGET_EXISTS: {
    facts: NONE,
    next: {
      default:
        'Check the path and read the existing file. Use mode "overwrite" only if replacing that file is intended.',
    },
  },
  NOT_REGULAR_FILE: {
    facts: NONE,
    next: { default: "Use the path of a regular file." },
  },
  MULTIPLE_HARD_LINKS: { facts: NONE },
  SYMLINK_UNRESOLVED: { facts: NONE },
  PUBLISH_FAILED: { facts: NONE },
  POST_PROCESS_FAILED: { facts: NONE },
  SEARCH_INCOMPLETE: { facts: facts(["diagnostics"], ["scanned", "scanLimit"]) },
  RIPGREP_FAILED: { facts: NONE },
  UNSUPPORTED_PATH: { facts: NONE },
  UNCLASSIFIED: { facts: NONE },
} as const satisfies Record<
  string,
  { facts: TObject; next?: { default: string } & Record<string, string> }
>;

type Definitions = typeof ERROR_DEFINITIONS;
export type ErrorCode = keyof Definitions;
export const ERROR_CODES = Object.keys(ERROR_DEFINITIONS) as ErrorCode[];
/** The facts a failure of `code` carries. */
export type ErrorFacts<C extends ErrorCode> = C extends ErrorCode
  ? keyof Static<Definitions[C]["facts"]> extends never
    ? Readonly<Record<string, never>>
    : Static<Definitions[C]["facts"]>
  : never;
/** Recovery alternatives a throw site may select for `code`. */
export type NextVariant<C extends ErrorCode> = Definitions[C] extends {
  next: infer N;
}
  ? Exclude<keyof N, "default">
  : never;

/** The guideline that ranks a report's own `next` above the general guidelines, which never restate it. */
export const NEXT_GUIDELINE =
  "When a tool report includes next, follow it for that result; it takes precedence over these guidelines.";

/** Text shared by success and failure: a file whose current anchors are unknown must be read first. */
const REREAD = "Read the file before further edits.";

/** Once a mutation reached or may have reached the file, a retry could apply it twice. */
export const PUBLICATION_NEXT = {
  PUBLISHED: `The change is saved; do not repeat it. ${REREAD}`,
  UNKNOWN:
    "The change may or may not be saved. Read the file, and repeat the change only if it is missing.",
} as const satisfies Record<Exclude<PublicationStatus, "NOT_PUBLISHED">, string>;

/** One fact's recovery; `except` is a value of that fact which needs none. */
/** One fact's recovery; `except` is a value of that fact which needs none. */
type OutcomeRule =
  | {
      [F in FactName]: readonly [fact: F, next: string, except?: Static<FactSchema<F>>];
    }[FactName]
  | readonly [fact: "publication", next: string, except?: PublicationStatus];

/**
 * Recovery after a successful result, by the first fact present in this order.
 * A fact absent from this list, or holding the value its rule excepts, needs no recovery beyond itself.
 */
export const OUTCOME_NEXT: readonly OutcomeRule[] = [
  // A file that no longer exists has no anchors to refresh.
  ["freshness", REREAD, "missing"],
  [
    "publication",
    "The file already has this content; nothing was written, so do not repeat the call.",
    "PUBLISHED",
  ],
  [
    "lineTooLong",
    "Inspect the line in chunks with bash, or use replace for a known literal or regex change; a smaller limit cannot split a line.",
  ],
  ["pagination", "If you need more lines, set offset to pagination.nextOffset."],
  // Ahead of matchLimit: once the byte budget cuts the output, raising limit shows nothing more.
  ["outputLimit", "Narrow path, glob, or pattern to see the omitted output."],
  ["matchLimit", "If you need more matches, raise limit to include rows after the last one shown."],
  [
    "literalPipe",
    "If you meant alternatives, give each as its own pattern item. Otherwise, keep literal matching.",
  ],
  [
    "scanLimit",
    "Narrow path or glob, or add text every match must contain, to search the remaining files.",
  ],
  ["linePreviewLimit", "Read the full line before rewriting it from a partial preview."],
];

/** The report envelope and facts, in output order; `next` is always last. */
export const REPORT_SCHEMA = Type.Object({
  error: opt(Type.Union(ERROR_CODES.map((code) => Type.Literal(code)))),
  tool: Type.String(),
  path: opt(Type.Union([Type.String(), Type.Array(Type.String())])),
  publication: opt(PUBLICATION_SCHEMA),
  message: opt(Type.String()),
  cause: opt(CAUSE_SCHEMA),
  ...(Object.fromEntries(
    Object.entries(FACT_FIELDS).map(([name, definition]) => [name, opt(definition.schema)]),
  ) as { [K in FactName]: ReturnType<typeof Type.Optional<FactSchema<K>>> }),
  next: opt(Type.String()),
});
type ReportFields = (Omit<Static<typeof REPORT_SCHEMA>, "error"> & { error?: ErrorCode }) &
  (AllFactsAreCarried extends true ? unknown : never);

const SUCCESS_DEFINITIONS = {
  read: facts([], ["pagination", "outputLimit", "lineTooLong"]),
  grep: facts(
    [],
    [
      "matches",
      "files",
      "scanned",
      "matchLimit",
      "scanLimit",
      "outputLimit",
      "linePreviewLimit",
      "invalidUtf8",
      "diagnostics",
      "literalPipe",
    ],
  ),
  edit: facts([]),
  replace: facts([], ["matches"]),
  write: facts([], ["created"]),
} as const;
export type ReportTool = keyof typeof SUCCESS_DEFINITIONS;
/** Tools whose reports carry publication, freshness, and the then_run outcome. */
const MUTATION_TOOLS = ["edit", "replace", "write"] as const satisfies readonly ReportTool[];
export type MutationToolName = (typeof MUTATION_TOOLS)[number];
/** Argument rejections may omit message; Pi supplies none for them. */
const MESSAGE_OPTIONAL = "INVALID_ARGUMENTS" satisfies ErrorCode;

const TOOL_SCHEMA = Type.Union(Object.keys(SUCCESS_DEFINITIONS).map((tool) => Type.Literal(tool)));
const COMMON_WIRE_FIELDS = {
  tool: TOOL_SCHEMA,
  path: REPORT_SCHEMA.properties.path,
  next: REPORT_SCHEMA.properties.next,
};
const MUTATION_WIRE_FIELDS = {
  publication: REPORT_SCHEMA.properties.publication,
  freshness: REPORT_SCHEMA.properties.freshness,
  freshnessError: REPORT_SCHEMA.properties.freshnessError,
  then_run: REPORT_SCHEMA.properties.then_run,
  progressError: REPORT_SCHEMA.properties.progressError,
};
const FAILURE_SCHEMAS = ERROR_CODES.map((code) =>
  Type.Object(
    {
      ...COMMON_WIRE_FIELDS,
      ...MUTATION_WIRE_FIELDS,
      cause: REPORT_SCHEMA.properties.cause,
      error: Type.Literal(code),
      message: code === MESSAGE_OPTIONAL ? opt(Type.String()) : Type.String(),
      ...ERROR_DEFINITIONS[code].facts.properties,
    },
    { additionalProperties: false },
  ),
);
const SUCCESS_SCHEMAS = Object.entries(SUCCESS_DEFINITIONS).map(([tool, schema]) =>
  Type.Object(
    {
      ...COMMON_WIRE_FIELDS,
      tool: Type.Literal(tool),
      ...((MUTATION_TOOLS as readonly string[]).includes(tool) ? MUTATION_WIRE_FIELDS : {}),
      ...schema.properties,
    },
    { additionalProperties: false },
  ),
);
/** Closed records after the originating call supplies the tool; failure facts remain code-specific. */
export const WIRE_REPORT_SCHEMA = Type.Union([...FAILURE_SCHEMAS, ...SUCCESS_SCHEMAS]);

type SuccessFactNames = {
  [Tool in ReportTool]: keyof Static<(typeof SUCCESS_DEFINITIONS)[Tool]>;
}[ReportTool] &
  string;
type ErrorFactNames = {
  [Code in ErrorCode]: keyof Static<(typeof ERROR_DEFINITIONS)[Code]["facts"]>;
}[ErrorCode] &
  string;
type MutationWireFactNames = keyof Fields<typeof MUTATION_WIRE_FIELDS> & string;
type UnusedFactNames = Exclude<FactName, SuccessFactNames | ErrorFactNames | MutationWireFactNames>;
type AssertTrue<T extends true> = T;
type AllFactsAreCarried = AssertTrue<UnusedFactNames extends never ? true : false>;

// Static counterparts of the per-tool and per-code wire schemas above, built from the same fields.
type Fields<P extends TProperties> = Static<TObject<P>>;
type Envelope = Omit<Fields<typeof COMMON_WIRE_FIELDS>, "tool">;
type MutationFields = Fields<typeof MUTATION_WIRE_FIELDS>;

/** Facts owned by one successful tool, derived from its wire schema. */
export type SuccessFacts<T extends ReportTool> = Static<(typeof SUCCESS_DEFINITIONS)[T]>;

// Absent fields stay readable as undefined without admitting another variant's facts.
type ReportVariant<T> = T & { [K in Exclude<keyof ReportFields, keyof T>]?: never };

/** A success report a tool may produce: its own facts, and mutation facts only for mutation tools. */
export type SuccessReport = {
  [T in ReportTool]: ReportVariant<
    Envelope & { tool: T } & (T extends MutationToolName ? MutationFields : unknown) &
      SuccessFacts<T>
  >;
}[ReportTool];

/** A failure report: its code's facts, with message required except where MESSAGE_OPTIONAL allows. */
export type FailureReport = {
  [C in ErrorCode]: ReportVariant<
    Envelope & { tool: ReportTool; error: C } & MutationFields &
      Pick<ReportFields, "cause"> &
      (C extends typeof MESSAGE_OPTIONAL ? { message?: string } : { message: string }) &
      Static<Definitions[C]["facts"]>
  >;
}[ErrorCode];

/** A checked report retains the tool or error code that determines its facts. */
export type Report = SuccessReport | FailureReport;
