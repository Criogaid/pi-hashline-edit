/** Independent argument checks for the file operation and its optional Bash command. */
import { isProxy } from "node:util/types";
import { Type, type Static, type TObject, type TProperties } from "typebox";
import { errorMessage } from "../core/errors.ts";
import {
  cloneArguments,
  createArgumentBoundary,
  noArgumentProduct,
  type CheckArguments,
} from "./argument-validation.ts";
import { reportOf } from "./report.ts";
import type { OutputBudgetProvider } from "./budgets.ts";
import type { MutationToolName } from "./report-schema.ts";

export const MILLISECONDS_PER_SECOND = 1_000;
// Pi's built-in Bash rejects timeouts above the setTimeout millisecond limit.
export const MAX_BASH_TIMEOUT_SECONDS = 2_147_483_647 / MILLISECONDS_PER_SECOND;

const command = Type.String({ description: "Bash command to run." });
const timeout = Type.Optional(
  Type.Number({
    exclusiveMinimum: 0,
    maximum: MAX_BASH_TIMEOUT_SECONDS,
    description: "Timeout in seconds; none when omitted.",
  }),
);
const commandArguments = Type.Object(
  {
    then_run: Type.Optional(
      Type.Object(
        {
          command: Type.String({ ...command, pattern: "\\S" }),
          timeout,
        },
        { additionalProperties: false },
      ),
    ),
  },
  { additionalProperties: false },
);
export type ThenRunInput = NonNullable<Static<typeof commandArguments>["then_run"]>;
export type ThenRunRequest =
  | ThenRunInput
  | { readonly commandText: string; readonly error: string };

type RejectedThenRun = Extract<ThenRunRequest, { readonly error: string }>;

// Pi clones and validates prepared arguments before hooks. Keep a rejected request present so a
// hook supplying defaults for an absent command cannot start Bash. Its empty command also fails
// the execution schema on its own. The diagnostic is never a shell argument.
const REJECTED = "__hashlineThenRunError";

function encodeRejected(commandText: string, error: string) {
  return { command: "", [REJECTED]: { commandText, error } };
}

function decodeRejected(value: object, tool: MutationToolName): RejectedThenRun | undefined {
  if (!Object.hasOwn(value, REJECTED)) return undefined;
  const marker: unknown = Reflect.get(value, REJECTED);
  if (!marker || typeof marker !== "object") return undefined;
  const commandText: unknown = Reflect.get(marker, "commandText");
  const error: unknown = Reflect.get(marker, "error");
  if (
    typeof commandText !== "string" ||
    typeof error !== "string" ||
    reportOf({ content: [{ type: "text", text: error }] }, tool)?.error !== "INVALID_ARGUMENTS"
  )
    return undefined;
  return { commandText, error };
}

function rawCommandText(value: unknown): string {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "";
  const text: unknown = Reflect.get(value, "command");
  return typeof text === "string" ? text : "";
}

/** Let structuredClone observe fields in their original order and with the original receiver. */
function mapFollowUp(
  input: unknown,
  visit: (read: () => { then_run: unknown }) => unknown,
  budgets: OutputBudgetProvider,
): unknown {
  if (
    !input ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    isProxy(input) ||
    !Object.prototype.propertyIsEnumerable.call(input, "then_run")
  )
    return input;
  const proto: unknown = Object.getPrototypeOf(input);
  if (proto !== null && proto !== Object.prototype) {
    // Built-ins such as Date drop custom properties when cloned. Class instances become records.
    return mapFollowUp(cloneArguments(input, budgets), visit, budgets);
  }
  const view = {};
  for (const key of Object.keys(input)) {
    Object.defineProperty(view, key, {
      enumerable: true,
      get:
        key === "then_run"
          ? () =>
              visit(() =>
                cloneArguments(
                  {
                    get then_run() {
                      return Reflect.get(input, key);
                    },
                  },
                  budgets,
                  "then_run",
                ),
              )
          : () => Reflect.get(input, key),
    });
  }
  return view;
}

export function createMutationArgumentBoundary<P extends TProperties, Parsed>(
  schema: TObject<P>,
  tool: MutationToolName,
  actionFusion: boolean,
  cwd: string,
  budgets: OutputBudgetProvider,
  check: CheckArguments<Parsed>,
) {
  if (!actionFusion) {
    const file = createArgumentBoundary(schema, cwd, budgets, check);
    return {
      parameters: schema,
      prepareArguments: file.prepareArguments,
      afterHooks: (input: unknown) => ({ ...file.afterHooks(input), thenRun: undefined }),
    };
  }
  const parameters = Type.Object(
    {
      ...schema.properties,
      then_run: Type.Optional(
        Type.Object(
          { command, timeout },
          {
            description: `Command to run once after ${tool} succeeds; failure does not roll back the file.`,
          },
        ),
      ),
    },
    { additionalProperties: false },
  );
  const file = createArgumentBoundary(
    Type.Object(
      { ...schema.properties, then_run: Type.Optional(Type.Unknown()) },
      { additionalProperties: false },
    ),
    cwd,
    budgets,
    check,
  );
  const bash = createArgumentBoundary(commandArguments, cwd, budgets, () => noArgumentProduct);
  return {
    parameters,
    prepareArguments(input: unknown): Static<typeof parameters> {
      const prepared = file.prepareArguments(
        mapFollowUp(
          input,
          (read) => {
            let commandText = "";
            try {
              const snapshot = read();
              commandText = rawCommandText(snapshot.then_run);
              return bash.prepareArguments(snapshot).then_run;
            } catch (error) {
              return encodeRejected(commandText, errorMessage(error));
            }
          },
          budgets,
        ),
      );
      // Pi applies the registered schema's coercion to the same raw fields after preparation.
      return prepared as Static<typeof parameters>;
    },
    afterHooks(input: unknown) {
      let thenRun: ThenRunRequest | undefined;
      const mutation = file.afterHooks(
        mapFollowUp(
          input,
          (read) => {
            let commandText = "";
            try {
              const snapshot = read();
              const value = snapshot.then_run;
              commandText = rawCommandText(value);
              if (value && typeof value === "object") {
                const rejected = decodeRejected(value, tool);
                if (rejected) {
                  if (Object.keys(value).length === 2 && Reflect.get(value, "command") === "") {
                    thenRun = rejected;
                    return undefined;
                  }
                  Reflect.deleteProperty(value, REJECTED);
                }
              }
              thenRun = bash.afterHooks(snapshot).args.then_run;
            } catch (error) {
              thenRun = { commandText, error: errorMessage(error) };
            }
            return undefined;
          },
          budgets,
        ),
      );
      // TypeBox cannot infer the base mapped type after removing the independently checked field.
      Reflect.deleteProperty(mutation.args, "then_run");
      return { ...mutation, args: mutation.args as Static<typeof schema>, thenRun };
    },
  };
}
