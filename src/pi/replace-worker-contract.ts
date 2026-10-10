/**
 * Replacement worker replies: result schemas and classified error facts are
 * checked on receipt. Reply decoding runs in the main thread; the worker itself
 * imports only report-cause.ts (workerFailure), because plain jiti lacks the
 * host's typebox mapping.
 */
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import { HashlineError, type HashlineErrorArguments } from "../core/errors.ts";
import {
  ERROR_CODES,
  ERROR_DEFINITIONS,
  CAUSE_SCHEMA,
  type ErrorCode,
  type ErrorFacts,
  type Cause,
} from "./report-schema.ts";
import { restoreCause, type WorkerFailure } from "./report-cause.ts";

const RESULT_SCHEMA = Type.Object(
  {
    text: Type.String(),
    count: Type.Integer({ minimum: 1 }),
  },
  { additionalProperties: false },
);
const ERROR_SCHEMAS = ERROR_CODES.map((code) => {
  const facts = ERROR_DEFINITIONS[code].facts;
  return Type.Object(
    {
      code: Type.Literal(code),
      message: Type.String(),
      facts: (facts.required?.length ?? 0) > 0 ? facts : Type.Optional(facts),
      cause: Type.Optional(CAUSE_SCHEMA),
    },
    { additionalProperties: false },
  );
});
const REPLY_SCHEMA = Type.Union([
  Type.Object({ result: RESULT_SCHEMA }, { additionalProperties: false }),
  Type.Object({ error: Type.Union(ERROR_SCHEMAS) }, { additionalProperties: false }),
]);
type WorkerError = {
  [C in ErrorCode]: { code: C; message: string; cause?: Cause } & ({} extends ErrorFacts<C>
    ? { facts?: ErrorFacts<C> }
    : { facts: ErrorFacts<C> });
}[ErrorCode];
type WorkerReply = { result: Static<typeof RESULT_SCHEMA> } | WorkerFailure;

export function decodeWorkerReply(value: unknown): WorkerReply | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  try {
    const error: unknown = Reflect.get(value, "error");
    if (typeof error === "object" && error !== null) {
      // Worker cloning permits cycles and BigInt; diagnostics must survive the JSON report boundary.
      JSON.stringify(error);
    }
    // Dynamic code arrays share their definitions with the statically mapped union.
    return Value.Check(REPLY_SCHEMA, value) ? (value as WorkerReply) : undefined;
  } catch (error) {
    if (error instanceof TypeError || error instanceof RangeError) return undefined;
    throw error;
  }
}

/** The caller supplies only a reply accepted by decodeWorkerReply. */
/** The caller supplies only a reply accepted by decodeWorkerReply. */
export function restoreWorkerError(error: {
  readonly code: string;
  readonly message: string;
  readonly facts?: unknown;
  readonly cause?: Cause;
}): HashlineError {
  const options = [
    { facts: error.facts, cause: restoreCause(error.cause) },
  ] as HashlineErrorArguments<ErrorCode>;
  return new HashlineError(error.code as ErrorCode, error.message, ...options);
}
