/**
 * Replacement worker data boundary. Request/result schemas and classified
 * error facts are checked on receipt; cause transport stays independent of Pi.
 */
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import { REPLACEMENTS_SCHEMA } from "../core/replace-schema.ts";
import { HashlineError, type HashlineErrorArguments } from "../core/errors.ts";
import {
  ERROR_CODES,
  ERROR_DEFINITIONS,
  CAUSE_SCHEMA,
  type ErrorCode,
  type ErrorFacts,
  type Cause,
} from "./report-schema.ts";
import { boundedText, causeOf, restoreCause } from "./report-cause.ts";

const REQUEST_SCHEMA = Type.Object(
  {
    source: Type.String(),
    rules: REPLACEMENTS_SCHEMA,
  },
  { additionalProperties: false },
);
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
type WorkerRequest = Static<typeof REQUEST_SCHEMA>;
type WorkerError = {
  [C in ErrorCode]: { code: C; message: string; cause?: Cause } & ({} extends ErrorFacts<C>
    ? { facts?: ErrorFacts<C> }
    : { facts: ErrorFacts<C> });
}[ErrorCode];
type WorkerFailure = { error: WorkerError };
type WorkerReply = { result: Static<typeof RESULT_SCHEMA> } | WorkerFailure;

export function decodeWorkerRequest(value: unknown): WorkerRequest | undefined {
  return Value.Check(REQUEST_SCHEMA, value) ? (value as WorkerRequest) : undefined;
}

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

/** Encode the throwing step and its underlying failures independently. */
export function workerFailure(caught: unknown): WorkerFailure {
  if (caught instanceof HashlineError) {
    // Its constructor enforced the code/facts relationship before crossing the boundary.
    return {
      error: {
        code: caught.errorCode,
        message: boundedText(caught.message),
        ...(caught.facts === undefined ? {} : { facts: caught.facts }),
        ...(caught.cause === undefined ? {} : { cause: causeOf(caught.cause) }),
      },
    } as WorkerFailure;
  }
  return {
    error: {
      code: "REGEX_WORKER_FAILED",
      message: "Regex evaluation failed.",
      cause: causeOf(caught),
    },
  };
}

/** The caller supplies only a reply accepted by decodeWorkerReply. */
export function restoreWorkerError(error: WorkerError): HashlineError {
  // Runtime schema validation established the mapped code/facts tuple.
  const options = [
    { facts: error.facts, cause: restoreCause(error.cause) },
  ] as HashlineErrorArguments<ErrorCode>;
  return new HashlineError(error.code, error.message, ...options);
}
