/**
 * Shared execution pipeline for the file mutation tools (edit, replace, write).
 *
 * `mutationToolBase` assembles the definition every mutation tool shares:
 * then_run's field and guideline when Action Fusion is on,
 * argument preparation, strict sampling, and execution. Each tool supplies its schema, text,
 * semantic checks, and `run`, and adds its own renderers.
 *
 * Owns the sequencing every mutation tool must keep identical once Pi has
 * checked the arguments: the shared file mutation queue, the hand-off to Action Fusion, and
 * finalization. Each tool returns a typed `MutationOutcome` (commit facts,
 * details, outcome facts); Action Fusion returns facts too, and this module's
 * single `finalizeMutation` call turns them into the result, so nothing
 * downstream reads publication or revisions back from result details. Every
 * failure leaves as one report with the call's path and publication.
 *
 * `runTextMutation` adds the read-modify-write sequence shared by edit and
 * replace: snapshot bound to the bytes read, cancellation before apply and
 * before write, revision-checked commit, and result generation that keeps the
 * publication status on failure. Tools supply only the text transformation.
 *
 * @module pi-hashline-edit/pi
 */

import { withFileMutationQueue, type ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import type { AgentToolResult, AgentToolUpdateCallback } from "@earendil-works/pi-agent-core";
import type { Static, TObject, TProperties } from "typebox";
import { ACTION_FUSION_GUIDELINES } from "./action-fusion.ts";
import type { CheckArguments } from "./argument-validation.ts";
import { createMutationArgumentBoundary } from "./fusion-arguments.ts";
import {
  SCRIPT_OUTPUT_SCHEMAS,
  type MutationFacts,
  type MutationToolName,
  type PublicationStatus,
} from "./report-schema.ts";
import {
  commitFile,
  FileMutationError,
  type CommitIntent,
  type CommitResult,
} from "./file-commit.ts";
import { readEditableSnapshot } from "./file-read.ts";
import {
  describeMutationFailure,
  finalizeMutation,
  generateMutationDetails,
  type MutationCommandFacts,
  type MutationOutcome,
  type MutationScheduler,
  type MutationFinalDetails,
  type MutationResultDetails,
} from "./mutation-result.ts";
import { callSignal, throwIfCancelled } from "./error-text.ts";
import { runTool } from "./report.ts";
import type { OutputBudgets } from "./budgets.ts";
import type { ToolEnvironment } from "./config.ts";
import { STRICT_SAMPLING } from "./schema.ts";
import type { CopiedSpan } from "../core/copy-span.ts";

/** With Action Fusion off, each call runs alone under Pi's file mutation queue. */
export const runAlone: MutationScheduler = async ({ mutate }) => ({
  kind: "alone",
  outcome: await mutate(),
});

/** A mutation tool's registration environment. */
export interface MutationToolEnvironment extends ToolEnvironment {
  /** `runAlone`, or Action Fusion's scheduler when the actionFusion setting is on. */
  readonly schedule: MutationScheduler;
}

/** Result details shared by the read-modify-write tools. */
type TextMutationDetails = ReturnType<typeof generateMutationDetails>;

/** The file a mutation targets, resolved once per call. */
export interface MutationTarget {
  readonly absolutePath: string;
  publish(text: string, intent: CommitIntent): Promise<CommitResult>;
  readonly signal: AbortSignal;
  readonly budget: OutputBudgets;
}

/** What a mutation tool supplies to the shared definition; renderers stay with the tool. */
interface MutationToolSpec<P extends TProperties, TDetails, TTool extends MutationToolName, Parsed>
  extends MutationToolEnvironment {
  readonly tool: TTool;
  /** Parameters without then_run, which Action Fusion adds. */
  readonly schema: TObject<P>;
  readonly description: string;
  readonly promptSnippet: string;
  readonly promptGuidelines?: readonly string[];
  /** Semantic argument checks and any execution data they derive. */
  readonly check: CheckArguments<Parsed>;
  /** Perform the mutation. Runs inside the file mutation queue. */
  run(
    params: Static<TObject<P>>,
    target: MutationTarget,
    parsed: NoInfer<Parsed>,
  ): Promise<MutationOutcome<TDetails, NoInfer<TTool>>>;
}

/**
 * The definition every mutation tool shares. Action Fusion adds then_run to the
 * schema and guidelines only when it is on. The argument boundary separates
 * the file and follow-up verdicts. Execution queues and publishes the file
 * operation before settling the follow-up.
 */
export function mutationToolBase<
  P extends TProperties,
  TDetails extends object,
  TTool extends MutationToolName,
  Parsed,
>(spec: MutationToolSpec<P, TDetails, TTool, Parsed>) {
  const { tool, cwd, schema, schedule, budgets } = spec;
  const { actionFusion } = spec.config;
  const boundary = createMutationArgumentBoundary(
    schema,
    tool,
    actionFusion,
    cwd,
    budgets,
    spec.check,
  );
  return {
    name: tool,
    label: tool,
    description: spec.description,
    promptSnippet: spec.promptSnippet,
    promptGuidelines: [
      ...(spec.promptGuidelines ?? []),
      ...(actionFusion ? ACTION_FUSION_GUIDELINES : []),
    ],
    parameters: boundary.parameters,
    outputSchema: SCRIPT_OUTPUT_SCHEMAS[tool],
    prepareArguments: boundary.prepareArguments,
    constrainedSampling: STRICT_SAMPLING,
    renderShell: "default" as const,
    async execute(
      toolCallId: string,
      params: Static<typeof boundary.parameters>,
      piSignal: AbortSignal | undefined,
      piOnUpdate: AgentToolUpdateCallback<MutationResultDetails<TDetails>> | undefined,
      ctx: ExtensionToolContext,
    ): Promise<AgentToolResult<MutationFinalDetails<TDetails>>> {
      const signal = callSignal(piSignal);
      // Pi's agent loop always supplies a callback; a direct call without one has no display.
      const onUpdate = piOnUpdate ?? (() => {});
      const {
        args: mutationParams,
        parsed,
        paths: [{ absolutePath, spelling: displayPath }],
        thenRun,
      } = boundary.afterHooks(params);
      const budget = budgets();
      let commit: CommitResult | undefined;
      let failedPublication: PublicationStatus | undefined;
      let command: MutationCommandFacts = {};
      const result = await runTool(
        tool,
        { path: displayPath, signal, budget },
        async () => {
          const target: MutationTarget = {
            absolutePath,
            signal,
            budget,
            async publish(text, intent) {
              try {
                commit = await commitFile(absolutePath, text, intent, signal);
                return commit;
              } catch (error) {
                if (error instanceof FileMutationError) failedPublication = error.publication;
                throw error;
              }
            },
          };
          const mutate = (): Promise<MutationOutcome<TDetails, TTool>> =>
            withFileMutationQueue(absolutePath, () => spec.run(mutationParams, target, parsed));
          const settled = await schedule({
            toolCallId,
            absolutePath,
            thenRun,
            mutate,
            signal,
            ctx,
            onUpdate,
            recordCommand(facts) {
              // Each fact is final when first observed, including the first display error.
              command = { ...facts, ...command };
            },
          });
          return finalizeMutation(displayPath, settled, command.progressFailure, budget);
        },
        (tool, error, context) =>
          describeMutationFailure(tool, error, { ...context, commit, failedPublication, command }),
      );
      return command.terminate === undefined ? result : { ...result, terminate: command.terminate };
    },
  };
}

/** A whole-file text transformation produced from one snapshot. */
interface TextChange<TTool extends MutationToolName> {
  /** Complete replacement text; equal to the snapshot for a no-op. */
  readonly text: string;
  /** Identical ranges copied from the snapshot, used to delimit the diff. */
  readonly copied: readonly CopiedSpan[];
  /** The tool's own outcome facts, such as replace's match count. */
  readonly facts: MutationFacts<TTool>;
}

/**
 * Read-modify-write against the bytes read: the commit is rejected if the file
 * changed since the snapshot, and result-generation failures keep publication.
 */
export async function runTextMutation<TTool extends MutationToolName>(
  target: MutationTarget,
  change: (currentText: string) => TextChange<TTool> | Promise<TextChange<TTool>>,
): Promise<MutationOutcome<TextMutationDetails, TTool>> {
  const { absolutePath, signal } = target;

  const { text: currentText, baseRevision } = await readEditableSnapshot(absolutePath, signal);
  // Cancelled after read: don't transform; the file stays untouched.
  throwIfCancelled(signal);

  const next = await change(currentText);

  // Cancelled before write: don't touch the disk.
  throwIfCancelled(signal);

  const commit = await target.publish(next.text, { mode: "update", baseRevision });
  return {
    commit,
    details: generateMutationDetails(currentText, next.text, next.copied),
    facts: next.facts,
  };
}
