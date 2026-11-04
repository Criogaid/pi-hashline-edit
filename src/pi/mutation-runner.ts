/**
 * Shared execution pipeline for the file mutation tools (edit, replace, write).
 *
 * `mutationToolBase` assembles the definition every mutation tool shares:
 * then_run's field, description, and guideline when Action Fusion is on,
 * argument preparation, strict sampling, and execution. Each tool supplies its schema, text,
 * semantic checks, and `run`, and adds its own renderers.
 *
 * Owns the sequencing every mutation tool must keep identical once Pi has
 * prepared and validated the arguments: separating then_run, path resolution,
 * the shared file mutation queue, the hand-off to Action Fusion, and
 * finalization. Each tool
 * returns a typed `MutationOutcome` (commit facts, details, outcome facts);
 * Action Fusion returns facts too, and this module's single `finalizeMutation`
 * call turns them into the result, so nothing
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
import {
  ACTION_FUSION_GUIDELINES,
  withThenRunDescription,
  withThenRunSchema,
  type createActionFusionExecutor,
  type FusedMutation,
  type ThenRunInput,
} from "./action-fusion.ts";
import { createArgumentPreparer, type CheckArguments } from "./argument-validation.ts";
import type { MutationToolName } from "./report-schema.ts";
import {
  commitFile,
  commitFreshness,
  FileMutationError,
  readEditableSnapshot,
} from "./file-commit.ts";
import {
  describeMutationFailure,
  finalizeMutation,
  generateMutationDetails,
  type MutationOutcome,
  type MutationFinalDetails,
  type MutationResultDetails,
  type MutationFacts,
} from "./mutation-result.ts";
import { canonicalPath } from "./path.ts";
import { throwIfCancelled } from "./error-text.ts";
import { runTool } from "./report.ts";
import type { OutputBudgetProvider, OutputBudgets } from "./budgets.ts";
import { STRICT_SAMPLING } from "./schema.ts";

export type ActionFusionExecutor = ReturnType<typeof createActionFusionExecutor>;

/** Result details shared by the read-modify-write tools. */
type TextMutationDetails = ReturnType<typeof generateMutationDetails>;

/** The file a mutation targets, resolved once per call. */
export interface MutationTarget {
  readonly absolutePath: string;
  readonly signal: AbortSignal | undefined;
  readonly budget: OutputBudgets;
}

/** A mutation tool's own parameters; `execute` separates then_run. */
type MutationParams<P extends TProperties> = Static<TObject<P>> & { readonly path: string };

/** What a mutation tool supplies to the shared definition; renderers stay with the tool. */
interface MutationToolSpec<P extends TProperties, TDetails, TTool extends MutationToolName> {
  readonly tool: TTool;
  readonly cwd: string;
  readonly fusion: ActionFusionExecutor | undefined;
  readonly budgets: OutputBudgetProvider;
  /** Parameters without then_run, which Action Fusion adds. */
  readonly schema: TObject<P>;
  readonly description: string;
  readonly promptSnippet: string;
  readonly promptGuidelines?: readonly string[];
  /** Semantic argument checks the schema cannot express. */
  readonly check?: CheckArguments;
  /** Perform the mutation. Runs inside the file mutation queue. */
  run(
    params: Omit<MutationParams<P>, "then_run">,
    target: MutationTarget,
  ): Promise<MutationOutcome<TDetails, TTool>>;
}

/**
 * The definition every mutation tool shares. Action Fusion adds then_run to the
 * schema, description, and guidelines only when it is on; arguments are prepared
 * against the parameters Pi registers; `execute` queues and publishes one
 * validated call, then runs its then_run command when fused.
 */
export function mutationToolBase<
  P extends TProperties,
  TDetails extends object,
  TTool extends MutationToolName,
>(spec: MutationToolSpec<P, TDetails, TTool>) {
  const { tool, cwd, schema, fusion, budgets } = spec;
  const actionFusion = fusion !== undefined;
  const parameters = withThenRunSchema(schema, tool, actionFusion);
  return {
    name: tool,
    label: tool,
    description: withThenRunDescription(spec.description, actionFusion),
    promptSnippet: spec.promptSnippet,
    promptGuidelines: [
      ...(spec.promptGuidelines ?? []),
      ...(actionFusion ? ACTION_FUSION_GUIDELINES : []),
    ],
    parameters,
    prepareArguments: createArgumentPreparer(tool, parameters, spec.check, budgets),
    constrainedSampling: STRICT_SAMPLING,
    renderShell: "default" as const,
    execute(
      toolCallId: string,
      params: MutationParams<P> & { then_run?: ThenRunInput },
      signal: AbortSignal | undefined,
      onUpdate: AgentToolUpdateCallback<MutationResultDetails<TDetails>> | undefined,
      ctx: ExtensionToolContext,
    ): Promise<AgentToolResult<MutationFinalDetails<TDetails>>> {
      const { then_run, ...mutationParams } = params;
      const displayPath = mutationParams.path;
      const budget = budgets();
      return runTool(
        tool,
        { path: displayPath, signal, budget },
        async () => {
          const absolutePath = canonicalPath(cwd, displayPath);
          const target: MutationTarget = { absolutePath, signal, budget };
          const mutate = (): Promise<MutationOutcome<TDetails, TTool>> =>
            withFileMutationQueue(absolutePath, () => spec.run(mutationParams, target));
          const settled: FusedMutation<TDetails, TTool> = fusion
            ? await fusion({
                toolCallId,
                absolutePath,
                thenRun: then_run,
                mutate,
                signal,
                ctx,
                onUpdate,
              })
            : await mutate().then((outcome) => ({
                outcome,
                observation: commitFreshness(outcome.commit),
              }));
          const { outcome, observation, command, terminate } = settled;
          const result = finalizeMutation(tool, displayPath, outcome, observation, command, budget);
          return terminate === undefined ? result : { ...result, terminate };
        },
        describeMutationFailure,
      );
    },
  };
}

/** A whole-file text transformation produced from one snapshot. */
interface TextChange<TTool extends MutationToolName> {
  /** Complete replacement text; equal to the snapshot for a no-op. */
  readonly text: string;
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

  const commit = await commitFile(absolutePath, next.text, {
    mode: "overwrite",
    baseRevision,
    signal,
  });
  try {
    return {
      commit,
      details: generateMutationDetails(currentText, next.text),
      facts: next.facts,
    };
  } catch (error) {
    // Keep result-building failures distinct from file publication failures.
    throw new FileMutationError(
      "POST_PROCESS_FAILED",
      commit.publication,
      "Result generation failed.",
      { cause: error },
    );
  }
}
