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
import { argumentItems, type ReportArgumentIssue } from "./argument-validation.ts";
import { filePathField, literalUnion } from "./schema.ts";

/** Split a validated anchor token; prepareArguments and the schema already checked it. */
function parseAnchor(value: string): Anchor;
function parseAnchor(value: string | undefined): Anchor | undefined;
function parseAnchor(value: string | undefined) {
  return value === undefined ? undefined : parseAnchorToken(value)!;
}

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
} as const satisfies Record<string, EditOpSpec>;
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

type EditOpInput = EditParams["steps"][number];
type EditOpSchema = EditSchema["properties"]["steps"]["items"];

/** How to correct edit argument issues; each reason states only what is wrong. */
const EDIT_ISSUE_FIX = {
  emptyReplace: 'Use {"action":"delete"} to remove lines, or supply the replacement lines.',
  emptyLines: 'Remove this step or supply at least one line ([""] for a blank line).',
  unsafeLine: 'Copy a complete "LINE#HASH" token from the latest tool result.',
  hashLength: "Read or grep the file for current anchors.",
} as const;

/**
 * Report semantic argument issues: the fields each op takes, and field values
 * the schema cannot judge. Malformed shapes remain Pi's schema responsibility;
 * Pi has already removed null optional fields.
 */
function checkEditArguments(
  args: unknown,
  hashLen: number,
  item: EditOpSchema,
  report: ReportArgumentIssue,
): void {
  argumentItems((args as { steps?: unknown } | null)?.steps).forEach((value, index) => {
    if (value === null || typeof value !== "object") return;
    const edit = value as Record<string, unknown>;
    // The schema reports an unknown action; which fields it takes is then unknown.
    if (typeof edit.action !== "string" || !Object.hasOwn(EDIT_OPS, edit.action)) return;
    const name = edit.action as EditOpName;
    const spec: EditOpSpec = EDIT_OPS[name];
    const path = `steps[${index}]`;
    const accepted = new Set([...spec.required, ...(spec.optional ?? [])]);
    for (const [field, declaration] of Object.entries(item.properties)) {
      if (field === "action") continue;
      const given = edit[field] !== undefined;
      if (given && !accepted.has(field as EditItemField))
        report(`${path}.${field}`, "is not allowed", `"${name}": ${describeEditOp(spec)}`);
      else if (!given && spec.required.includes(field as EditItemField))
        report(
          `${path}.${field}`,
          `is required for "${name}"`,
          Reflect.get(declaration, "description"),
        );
    }

    const lines = edit.lines;
    if (accepted.has("lines") && Array.isArray(lines)) {
      if (lines.length === 0) {
        report(
          `${path}.lines`,
          "is empty",
          name === "replace" ? EDIT_ISSUE_FIX.emptyReplace : EDIT_ISSUE_FIX.emptyLines,
        );
      }
      lines.forEach((line, lineIndex) => {
        const unwritable = typeof line === "string" ? unwritableTextError(line) : undefined;
        if (unwritable) report(`${path}.lines[${lineIndex}]`, unwritable.message);
      });
    }
    const cited: { anchor?: number; end?: number } = {};
    for (const field of EDIT_ANCHOR_FIELDS) {
      const anchor = edit[field];
      if (!accepted.has(field) || typeof anchor !== "string") continue;
      const token = parseAnchorToken(anchor);
      if (!token) continue;
      if (Number.isSafeInteger(token.line)) {
        cited[field] = token.line;
      } else {
        report(
          `${path}.${field}`,
          "line number exceeds the safe integer range",
          EDIT_ISSUE_FIX.unsafeLine,
        );
      }
      if (token.hash.length !== hashLen) {
        report(
          `${path}.${field}`,
          `has ${token.hash.length} hash characters; hashLen is ${hashLen}`,
          EDIT_ISSUE_FIX.hashLength,
        );
      }
    }

    // The cited line numbers alone decide this, whatever the file holds. An
    // unsafe line number was reported above, and comparing it would add a false issue.
    if (cited.anchor !== undefined && cited.end !== undefined && cited.end < cited.anchor) {
      report(`${path}.end`, `line ${cited.end} is before anchor line ${cited.anchor}`);
    }
  });
}

/**
 * Translate validated public operations into core steps, parsing numeric anchor
 * positions. Argument checks guarantee each op carries exactly the fields it takes.
 */
function toCoreEdits(ops: readonly EditOpInput[]): Edit[] {
  return ops.map((op) => {
    switch (op.action) {
      case "replace":
        return {
          op: "replace",
          anchor: parseAnchor(op.anchor!),
          end: parseAnchor(op.end),
          body: op.lines!,
        };
      case "delete":
        return { op: "delete", anchor: parseAnchor(op.anchor!), end: parseAnchor(op.end) };
      case "insert_after":
      case "insert_before":
        return { op: op.action, anchor: parseAnchor(op.anchor!), body: op.lines! };
      case "append":
      case "prepend":
        return { op: op.action, body: op.lines! };
    }
  });
}

/** Call header with total/per-kind operation counts and the result's diff counts. */
function editHeader(args: EditParams, theme: Theme, counts?: DiffCounts): string {
  let t = theme.fg("toolTitle", theme.bold("edit "));
  t += formatHeaderPath(args.path, theme);
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

  return {
    ...mutationToolBase({
      ...env,
      tool: "edit",
      schema,
      description:
        "Edit whole lines using LINE#HASH anchors checked against the current file. Use replace instead when the same change repeats in several places, or when only a fragment of a long line changes.",
      promptSnippet: "Edit file lines using verified anchors",
      promptGuidelines: [
        "Batch all steps for one file into a single edit call.",
        "Before citing a line after write, edit, or replace, get its anchor from a new read or grep. Only after edit, lines above the earliest changed line keep their anchors.",
      ],
      check: (args, report) =>
        checkEditArguments(args, hashLen, schema.properties.steps.items, report),
      run: (params, target) => runEdit(target, params.steps, hashLen, shiftRadius),
    }),
    ...diffCardRenderers("edit", "Editing…", editHeader),
  };
}

function runEdit(
  target: MutationTarget,
  editOps: readonly EditOpInput[],
  hashLen: number,
  shiftRadius: number,
) {
  const anchorFormatter = createAnchorFormatter(hashLen);

  return runTextMutation<"edit">(target, (currentText) => {
    // Recovery reports checksum candidates from nearby lines, then the whole file
    // if needed. Every failed anchor still rejects the batch; callers inspect
    // candidates and resubmit with fresh anchors.
    const result = applyEdits(currentText, toCoreEdits(editOps), hashLen, shiftRadius);
    if (!result.ok) {
      throw describeEditFailure(currentText, result.failures, anchorFormatter, target.budget);
    }
    return { text: result.text, facts: {} };
  });
}
