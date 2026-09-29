import { Value } from "typebox/value";
import type { Static, TSchema } from "typebox";

/** Validate direct execute calls against the same schema exposed to Pi. */
export function parseToolInput<T extends TSchema>(
  name: string,
  schema: T,
  input: unknown,
): Static<T> {
  if (Value.Check(schema, input)) return input;
  const details = Value.Errors(schema, input)
    .slice(0, 8)
    .map(
      (issue) =>
        `${issue.instancePath || "(root)"}: ${issue.keyword === "boolean" ? "parameter is not supported" : issue.message}`,
    );
  const detail = details.length ? details.join("; ") : "invalid arguments";
  throw new Error(`Validation failed for tool "${name}": ${detail}`);
}
