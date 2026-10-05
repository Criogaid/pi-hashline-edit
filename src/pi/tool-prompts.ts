/**
 * Model-facing guidance shared by more than one tool.
 *
 * Text that belongs to one tool stays next to that tool's schema, and Action
 * Fusion keeps its own guidelines and then_run wording in action-fusion.ts.
 * Pi's buildRules merges every active tool's promptGuidelines into one list and
 * drops entries whose trimmed text repeats, so tools that share a rule list the
 * same constant and the model sees it once.
 *
 * @module pi-hashline-edit/pi
 */

/** How edit, replace, and write divide file changes; listed by all three tools. */
export const MUTATION_TOOL_GUIDELINE =
  "For file changes, use edit for line or block changes, insertions, and deletions; replace for repeated literal or regex substitutions and short changes inside long lines; write for new files and whole-file rewrites.";

export const EPHEMERAL_TOOL_GUIDELINE =
  "Use ephemeral: true for one-time inspection of logs or large text with read or grep; retain needed conclusions in your response before the result expires. Keep normal retention when later steps need the returned content or anchors.";
