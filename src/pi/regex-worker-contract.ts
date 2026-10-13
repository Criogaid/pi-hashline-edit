/** Closed reply envelopes shared by isolated regex evaluators; decoded in the host. */
import { Type, type Static, type TSchema } from "typebox";
import { Value } from "typebox/value";
import {
  HashlineError,
  type HashlineErrorArguments,
  type HashlineErrorOptions,
} from "../core/errors.ts";
import {
  ERROR_CODES,
  ERROR_DEFINITIONS,
  CAUSE_SCHEMA,
  type ErrorCode,
  type Cause,
} from "./report-schema.ts";
import { restoreCause } from "./report-cause.ts";

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
/** A worker error that passed its code's schema: the facts are those that code requires. */
export type CheckedWorkerError = {
  [C in ErrorCode]: {
    readonly code: C;
    readonly message: string;
    readonly cause?: Cause;
  } & Pick<HashlineErrorOptions<C>, "facts">;
}[ErrorCode];
export type RegexWorkerReply<Result> =
  | { readonly result: Result }
  | { readonly error: CheckedWorkerError };

export function invalidWorkerResult(): HashlineError<"REGEX_WORKER_FAILED"> {
  return new HashlineError("REGEX_WORKER_FAILED", "Regex worker returned an invalid result.");
}

export function workerReplyDecoder<T extends TSchema>(result: T) {
  const schema = Type.Union([
    Type.Object({ result }, { additionalProperties: false }),
    Type.Object({ error: Type.Union(ERROR_SCHEMAS) }, { additionalProperties: false }),
  ]);
  return (value: unknown): RegexWorkerReply<Static<T>> | undefined => {
    if (typeof value !== "object" || value === null) return undefined;
    try {
      const error: unknown = Reflect.get(value, "error");
      // Structured cloning permits cycles and BigInt; reports must remain JSON-serializable.
      if (typeof error === "object" && error !== null) JSON.stringify(error);
      // The dynamic error union is validated against the same code-specific schemas.
      return Value.Check(schema, value) ? (value as RegexWorkerReply<Static<T>>) : undefined;
    } catch (error) {
      if (error instanceof TypeError || error instanceof RangeError) return undefined;
      throw error;
    }
  };
}

/** Restore an error workerReplyDecoder checked as the same HashlineError the worker threw. */
export function restoreWorkerError(error: CheckedWorkerError): HashlineError {
  // The parameter ties facts to code; TypeScript cannot carry that link into the generic constructor.
  const options = [
    { facts: error.facts, cause: restoreCause(error.cause) },
  ] as HashlineErrorArguments<ErrorCode>;
  return new HashlineError(error.code, error.message, ...options);
}
