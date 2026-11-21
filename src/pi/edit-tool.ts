/**
 * Override edit: hashline ops via structured `steps` (LINE#HASH anchors).
 *
 * Each op in `steps` references line anchors from read, grep, or edit failure diagnostics.
 * The core verifies each anchor live against
 * the current file content — no prior-read revision guard: a cited line
 * that changed (or was misremembered) fails its own anchor; unchanged lines
 * elsewhere never block the edit.
 *
 * Concurrency safety: read-modify-write is wrapped in withFileMutationQueue.
 * AbortSignal is honored — checked after read / before write.
 *
 * @module pi-hashline-edit/pi
 */

import type { Theme } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { applyEdits } from "../core/apply.ts";
import { unwritableTextError } from "../core/text.ts";
import { EDIT_ANCHOR_FIELDS, type Anchor, type Edit } from "../core/types.ts";
import { anchorPattern, createAnchorFormatter, parseAnchorToken } from "./anchor-format.ts";
import {
  diffCardRenderers,
  formatDiffCounts,
  formatHeaderPath,
  type DiffCounts,
} from "./render.ts";
import { describeEditFailure } from "./failure-context.ts";
import {
  mutationToolBase,
  runTextMutation,
  type MutationTarget,
  type MutationToolEnvironment,
} from "./mutation-runner.ts";
import type { ReportArgumentIssue } from "./argument-validation.ts";
import { filePathField, literalUnion } from "./schema.ts";

/** Operation item fields besides `action`. */
type EditItemField = (typeof EDIT_ANCHOR_FIELDS)[number] | "lines";

/** What one op does and which item fields it takes; it takes no others. */
interface EditOpSpec {
  readonly meaning: string;
  readonly required: readonly EditItemField[];
  readonly optional?: readonly EditItemField[];
}

/** Every op and its fields; the schema states them, and argument checks enforce them. */
const EDIT_OPS = {
  replace: {
    meaning: "Replace the cited line(s) with lines.",
    required: ["anchor", "lines"],
    optional: ["end"],
  },
  delete: { meaning: "Delete the cited line(s).", required: ["anchor"], optional: ["end"] },
  insert_after: {
    meaning: "Insert lines after the anchor line, which is kept; do not repeat it in lines.",
    required: ["anchor", "lines"],
  },
  insert_before: {
    meaning: "Insert lines before the anchor line, which is kept; do not repeat it in lines.",
    required: ["anchor", "lines"],
  },
  append: { meaning: "Add lines at the end of the file.", required: ["lines"] },
  prepend: { meaning: "Add lines at the start of the file.", required: ["lines"] },
} as const satisfies Record<Edit["op"], EditOpSpec>;
type EditOpName = keyof typeof EDIT_OPS;
const EDIT_OP_NAMES = Object.keys(EDIT_OPS) as EditOpName[];

/** Operations in one call; constrained sampling ends a runaway batch at this bound. */
const MAX_EDIT_OPS = 64;

/** An op's meaning followed by the fields it takes. */
function describeEditOp({ meaning, required, optional = [] }: EditOpSpec): string {
  return `${meaning} Takes ${required.join(" and ")}${optional.length ? `; ${optional.join(", ")} is optional` : ""}.`;
}

/**
 * Edit parameters; anchors must carry exactly `hashLen` hash characters. Each
 * operation is one flat object, so providers can constrain sampling to the
 * schema; argument checks enforce which fields each op takes.
 */
function buildEditSchema(hashLen: number) {
  const pattern = anchorPattern(hashLen);
  const anchorField = (description: string) => Type.Optional(Type.String({ pattern, description }));
  const editOpSchema = Type.Object(
    {
      // Session evidence is mixed: OpenAI calls usually follow declaration order, while
      // GLM and local calls often use lexical key order. Keep `action`, `anchor`,
      // `end`, `lines` so both orders choose the operation and range before its payload.
      action: literalUnion(EDIT_OP_NAMES, (op) => describeEditOp(EDIT_OPS[op])),
      anchor: anchorField("LINE#HASH of the target line."),
      end: anchorField("Inclusive last LINE#HASH of the range; omit for one line."),
      lines: Type.Optional(
        Type.Array(Type.String({ pattern: "^[^\\r\\n]*$" }), {
          minItems: 1,
          description:
            'New lines, one per element, without CR/LF. At least one; [""] is one blank line.',
        }),
      ),
    },
    {
      additionalProperties: false,
      description: "One step. Omit, or set to null, each field its action does not take.",
    },
  );
  return Type.Object(
    {
      path: filePathField(),
      steps: Type.Array(editOpSchema, {
        minItems: 1,
        maxItems: MAX_EDIT_OPS,
        description: `Steps applied to one snapshot; ranges must not overlap. Each gap between lines takes at most one insertion; insert_after N and insert_before N+1 target the same gap, so put all new lines for a gap in one step. An insertion at the start of a replaced or deleted range goes before it. Anchors are LINE#HASH with exactly ${hashLen} hash characters. Copy each anchor from read, grep, or edit failure diagnostics; never write a hash you have not seen there. Shell output such as sed, head, or cat has no anchors, so read or grep those lines first.`,
      }),
    },
    { additionalProperties: false },
  );
}
type EditSchema = ReturnType<typeof buildEditSchema>;

type EditParams = Static<EditSchema>;

type EditOpSchema = EditSchema["properties"]["steps"]["items"];

function editArgumentRules(item: EditOpSchema) {
  const { action: _action, ...fields } = item.properties;
  // Object keys preserve the step schema's diagnostic order.
  const fieldNames = Object.keys(fields) as EditItemField[];
  return new Map(
    EDIT_OP_NAMES.map((action) => {
      const spec: EditOpSpec = EDIT_OPS[action];
      const fix = `"${action}": ${describeEditOp(spec)}`;
      const rules = fieldNames.map((field) => {
        if (spec.required.includes(field))
          return {
            field,
            missing: {
              reason: `is required for "${action}"`,
              fix: Reflect.get(fields[field], "description"),
            },
          };
        if (spec.optional?.includes(field)) return { field };
        return { field, present: { reason: "is not allowed", fix } };
      });
      return [action as unknown, { action, rules }] as const;
    }),
  );
}

/** How to correct edit argument issues; each reason states only what is wrong. */
const EDIT_ISSUE_FIX = {
  emptyReplace: 'Use {"action":"delete"} to remove lines, or supply the replacement lines.',
  emptyLines: 'Remove this step or supply at least one line ([""] for a blank line).',
  unsafeLine: 'Copy a complete "LINE#HASH" token from the latest tool result.',
  hashLength: "Read or grep the file for current anchors.",
} as const;

/** Decode a cited token and leave shape errors to the schema. */
function parseCitedAnchor(
  value: unknown,
  field: string,
  hashLen: number,
  report: ReportArgumentIssue,
): Anchor | undefined {
  if (typeof value !== "string") return undefined;
  const token = parseAnchorToken(value);
  if (!token) return undefined;
  const safeLine = Number.isSafeInteger(token.line);
  if (!safeLine)
    report(field, "line number exceeds the safe integer range", EDIT_ISSUE_FIX.unsafeLine);
  if (token.hash.length !== hashLen)
    report(
      field,
      `has ${token.hash.length} hash characters; hashLen is ${hashLen}`,
      EDIT_ISSUE_FIX.hashLength,
    );
  // A hash-length error still allows a range comparison, but an unsafe line does not.
  return safeLine ? token : undefined;
}

function checkEditBody(
  lines: unknown,
  path: string,
  emptyFix: string,
  report: ReportArgumentIssue,
): string[] | undefined {
  if (!Array.isArray(lines)) return undefined;
  if (lines.length === 0) report(path, "is empty", emptyFix);
  for (const [index, line] of lines.entries()) {
    if (typeof line !== "string") continue;
    const unwritable = unwritableTextError(line);
    if (unwritable) report(`${path}[${index}]`, unwritable.message);
  }
  // The boundary releases the body only after the schema checks its item types.
  return lines as string[];
}

function checkEditStep(
  value: unknown,
  path: string,
  hashLen: number,
  rules: ReturnType<typeof editArgumentRules>,
  report: ReportArgumentIssue,
) {
  if (!(value instanceof Object)) return undefined;
  // The schema reports an unknown action; which fields it takes is then unknown.
  const rule = rules.get(Reflect.get(value, "action"));
  if (!rule) return undefined;
  const { action } = rule;
  const admitted: Partial<Record<EditItemField, unknown>> = {};
  for (const { field, missing, present } of rule.rules) {
    const input: unknown = Reflect.get(value, field);
    const issue = input === undefined ? missing : present;
    if (issue) report(`${path}.${field}`, issue.reason, issue.fix);
    else admitted[field] = input;
  }
  const body = checkEditBody(
    admitted.lines,
    `${path}.lines`,
    action === "replace" ? EDIT_ISSUE_FIX.emptyReplace : EDIT_ISSUE_FIX.emptyLines,
    report,
  );
  const anchor = parseCitedAnchor(admitted.anchor, `${path}.anchor`, hashLen, report);
  const end = parseCitedAnchor(admitted.end, `${path}.end`, hashLen, report);
  if (anchor && end && end.line < anchor.line)
    report(`${path}.end`, `line ${end.line} is before anchor line ${anchor.line}`);
  return { action, anchor, end, body };
}

type CheckedEditStep = {
  [Op in Edit as Op["op"]]: Omit<Op, "op"> & { action: Op["op"] };
}[EditOpName];

function buildEdit(step: CheckedEditStep): Edit {
  switch (step.action) {
    case "append":
    case "prepend":
      return { op: step.action, body: step.body };
    case "delete":
      return { op: step.action, anchor: step.anchor, end: step.end };
    case "replace":
      return { op: step.action, anchor: step.anchor, body: step.body, end: step.end };
    case "insert_after":
    case "insert_before":
      return { op: step.action, anchor: step.anchor, body: step.body };
    default:
      step satisfies never;
      throw new Error("Accepted edit step has an unknown action.");
  }
}

function parseEditArguments(
  args: unknown,
  hashLen: number,
  rules: ReturnType<typeof editArgumentRules>,
  report: ReportArgumentIssue,
): () => Edit[] {
  const steps = (args as { steps?: unknown } | null)?.steps;
  const drafts = Array.isArray(steps)
    ? steps.map((value: unknown, index) =>
        checkEditStep(value, `steps[${index}]`, hashLen, rules, report),
      )
    : [];
  // Schema validation admits only known actions and typed fields. The semantic check
  // enforces their presence and parses every admitted anchor. The verdict precedes this map.
  return () => (drafts as readonly CheckedEditStep[]).map(buildEdit);
}

/** Call header with total/per-kind operation counts and the result's diff counts. */
function editHeader(args: EditParams, theme: Theme, cwd: string, counts?: DiffCounts): string {
  let t = theme.fg("toolTitle", theme.bold("edit "));
  t += formatHeaderPath(args.path, theme, cwd);
  const steps = Array.isArray(args.steps) ? args.steps : [];
  const n = steps.length;
  if (n) {
    const opCounts: Record<string, number> = Object.fromEntries(
      [...EDIT_OP_NAMES, "unknown"].map((kind) => [kind, 0]),
    );
    // Renderers receive partial arguments; fixed buckets keep one-pass counting O(1) in space.
    for (const edit of steps) {
      const kind = edit?.action;
      if (typeof kind === "string" && Object.hasOwn(opCounts, kind)) opCounts[kind]++;
      else opCounts.unknown++;
    }
    const summary = Object.entries(opCounts)
      .filter(([, count]) => count > 0)
      .map(([kind, count]) => `${kind} ×${count}`)
      .join(", ");
    t += theme.fg("dim", ` — ${n} op${n > 1 ? "s" : ""}: ${summary}`);
  }
  if (counts && (counts.added || counts.removed)) t += formatDiffCounts(counts, theme);
  return t;
}

export function makeEditOverride(env: MutationToolEnvironment) {
  // Schema, verification, and recovery use the registered configuration.
  const { hashLen, shiftRadius } = env.config;
  const schema = buildEditSchema(hashLen);
  const rules = editArgumentRules(schema.properties.steps.items);

  return {
    ...mutationToolBase({
      ...env,
      tool: "edit",
      schema,
      description:
        "Edit whole lines using LINE#HASH anchors checked against the current file. Use replace instead when the same change repeats in several places, or when only a fragment of a long line changes.",
      promptSnippet: "Edit file lines using verified anchors",
      promptGuidelines: [
        "Batch all steps for one file into a single edit call, and send changes to different files in the same response; they do not interfere.",
        "Before citing a line after write, edit, or replace, get its anchor from a new read or grep. Only after edit, lines above the earliest changed line keep their anchors.",
      ],
      check: (args, report) => parseEditArguments(args, hashLen, rules, report),
      run: (_params, target, edits) => runEdit(target, edits, hashLen, shiftRadius),
    }),
    ...diffCardRenderers("edit", "Editing…", editHeader),
  };
}

function runEdit(
  target: MutationTarget,
  edits: readonly Edit[],
  hashLen: number,
  shiftRadius: number,
) {
  const anchorFormatter = createAnchorFormatter(hashLen);

  return runTextMutation<"edit">(target, (currentText) => {
    // Recovery reports checksum candidates from nearby lines, then the whole file
    // if needed. Every failed anchor still rejects the batch; callers inspect
    // candidates and resubmit with fresh anchors.
    const result = applyEdits(currentText, edits, hashLen, shiftRadius);
    if (!result.ok) {
      throw describeEditFailure(currentText, result.failures, anchorFormatter, target.budget);
    }
    return { text: result.text, copied: result.copied, facts: { tool: "edit" } };
  });
}
