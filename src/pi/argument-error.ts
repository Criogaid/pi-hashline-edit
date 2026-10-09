/** Model-facing argument rejection format and byte budget; never truncate a JSON record. */
import type { ArgumentIssue } from "./argument-diagnostics.ts";
import { MAX_ARGUMENT_REASON_BYTES, MAX_BLOCK_BYTES } from "./budgets.ts";
import { DiagnosticBuffer } from "./diagnostic-buffer.ts";

export interface ArgumentError {
  readonly error: "INVALID_ARGUMENTS";
  readonly tool: string;
  readonly executed: false;
  readonly issues: readonly ArgumentIssue[];
  readonly arguments?: unknown;
  readonly argumentsOmitted?: true;
  readonly schemaLimited?: true;
  readonly omittedIssues?: number;
}

/** Encode prepared arguments once; unsupported values and oversized copies are explicitly omitted. */
export function formatArgumentError(
  tool: string,
  issues: readonly ArgumentIssue[],
  prepared: unknown,
  schemaLimited: boolean,
): string {
  const bounded = issues.map(({ field, reason }) => {
    const buffer = new DiagnosticBuffer(MAX_ARGUMENT_REASON_BYTES);
    buffer.append(reason);
    return { field, reason: buffer.toString() };
  });
  const base = {
    error: "INVALID_ARGUMENTS",
    tool,
    executed: false,
    ...(schemaLimited ? { schemaLimited: true as const } : {}),
  } as const;
  const encode = (value: ArgumentError) => JSON.stringify(value, null, 2);
  const fits = (text: string) => Buffer.byteLength(text) <= MAX_BLOCK_BYTES;
  let argumentsCopy: unknown;
  let argumentsAvailable = false;
  try {
    const encoded = JSON.stringify(prepared, (_key, value: unknown) => {
      if (
        value === undefined ||
        typeof value === "function" ||
        typeof value === "symbol" ||
        typeof value === "bigint" ||
        (typeof value === "number" && !Number.isFinite(value))
      ) {
        throw new TypeError("Prepared arguments contain a value JSON cannot represent");
      }
      return value;
    });
    if (encoded !== undefined && fits(encoded)) {
      argumentsCopy = JSON.parse(encoded);
      argumentsAvailable = true;
    }
  } catch {
    // Pi preparation can fail before producing a JSON value (for example, a cycle).
    // Report the original cause through issues and label the missing argument copy.
  }
  if (argumentsAvailable) {
    const complete = encode({ ...base, issues: bounded, arguments: argumentsCopy });
    if (fits(complete)) return complete;
  }
  const withoutArguments = { ...base, argumentsOmitted: true } as const;
  const complete = encode({ ...withoutArguments, issues: bounded });
  if (fits(complete)) return complete;

  // An oversized field path must be omitted whole: a shortened path could name another field.
  const eligible = bounded.filter((issue) =>
    fits(encode({ ...withoutArguments, issues: [issue], omittedIssues: bounded.length - 1 })),
  );
  const frame = (count: number) => {
    const head = Math.ceil(count / 2);
    const tail = count - head;
    return encode({
      ...withoutArguments,
      issues: [...eligible.slice(0, head), ...(tail ? eligible.slice(-tail) : [])],
      omittedIssues: bounded.length - count,
    });
  };
  let low = 0;
  let high = eligible.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (fits(frame(middle))) low = middle;
    else high = middle - 1;
  }
  return frame(low);
}
