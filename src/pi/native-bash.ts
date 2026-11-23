/** Pi's Bash definition supplies the output schema and command-card renderers. */
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { JsonValue } from "@earendil-works/pi-ai";
import { createBashToolDefinition } from "@earendil-works/pi-coding-agent";
import type { TObject } from "typebox";
import { Value } from "typebox/value";

export const nativeBash = createBashToolDefinition(process.cwd());
// ToolDefinition erases the type of outputSchema. Built-in Bash declares an object schema.
export const BASH_OUTPUT_SCHEMA = nativeBash.outputSchema as TObject;
const outputKeys = Object.keys(BASH_OUTPUT_SCHEMA.properties);

/** A partial or unreadable hook result can still establish a numeric exit. */
export function snapshotBashOutput(
  result: Pick<AgentToolResult<unknown>, "structuredContent">,
  recordObserverFailure: (error: unknown) => void,
) {
  let exited = false;
  try {
    const value = result.structuredContent;
    if (
      value === null ||
      typeof value !== "object" ||
      !("exit_code" in value) ||
      Array.isArray(value)
    )
      return { exited };
    const exitCode = value.exit_code;
    if (!Value.Check(BASH_OUTPUT_SCHEMA.properties.exit_code, exitCode)) return { exited };
    exited = true;
    const fields: Record<string, JsonValue> = {};
    for (const key of outputKeys) {
      const field = key === "exit_code" ? exitCode : value[key];
      if (field !== undefined) fields[key] = field;
    }
    return { exited, structured: Value.Check(BASH_OUTPUT_SCHEMA, fields) ? fields : undefined };
  } catch (error) {
    recordObserverFailure(error);
    return { exited };
  }
}
