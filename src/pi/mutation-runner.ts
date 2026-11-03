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
 * the shared file mutation queue, and the hand-off to Action Fusion or plain
 * finalization. Each tool
 * returns a typed `MutationOutcome` (commit facts, details, outcome facts);
 * `finalizeMutation` alone turns it into the result, so nothing
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
  type ThenRunInput,
} from "./action-fusion.ts";
import { createArgumentPreparer, type CheckArguments } from "./argument-validation.ts";
import type { MutationToolName } from "./report-schema.ts";
import { commitFreshness, commitReplacement, readEditableSnapshot } from "./file-commit.ts";
import {
  finalizeMutation,
  generateMutationDetails,
  postProcessMutation,
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

interface MutationToolSpec<
  TParams extends { path: string },
  TDetails,
  TTool extends MutationToolName,
> {
  readonly tool: TTool;
  readonly cwd: string;
  readonly fusion: ActionFusionExecutor | undefined;
  readonly budgets: OutputBudgetProvider;
  /** Perform the mutation. Runs inside the file mutation queue. */
  run(
    params: Omit<TParams, "then_run">,
    target: MutationTarget,
  ): Promise<MutationOutcome<TDetails, TTool>>;
}

interface MutationCall<TParams, TDetails> {
  readonly toolCallId: string;
  /** Arguments already prepared and validated by Pi against the tool schema. */
  readonly params: TParams & { then_run?: ThenRunInput };
  readonly signal: AbortSignal | undefined;
  readonly onUpdate: AgentToolUpdateCallback<MutationResultDetails<TDetails>> | undefined;
  readonly ctx: ExtensionToolContext;
}

/** Queue and publish one validated mutation call, then run its then_run command when fused. */
async function executeMutation<
  TParams extends { path: string },
  TDetails extends object,
  TTool extends MutationToolName,
>(
  spec: MutationToolSpec<TParams, TDetails, TTool>,
  call: MutationCall<TParams, TDetails>,
): Promise<AgentToolResult<MutationFinalDetails<TDetails>>> {
  const { cwd, fusion, tool } = spec;
  const { toolCallId, signal, onUpdate, ctx } = call;
  const { then_run, ...mutationParams } = call.params;
  const displayPath = mutationParams.path;
  const budget = spec.budgets();
  return runTool(tool, { path: displayPath, signal, budget }, async () => {
    const absolutePath = canonicalPath(cwd, displayPath);
    const target: MutationTarget = { absolutePath, signal, budget };
    const mutate = (): Promise<MutationOutcome<TDetails, TTool>> =>
      withFileMutationQueue(absolutePath, () => spec.run(mutationParams, target));
    if (!fusion) {
      const outcome = await mutate();
      return finalizeMutation(
        tool,
        displayPath,
        outcome,
        commitFreshness(outcome.commit),
        undefined,
        budget,
      );
    }
    return fusion({
      toolCallId,
      tool,
      displayPath,
      absolutePath,
      thenRun: then_run,
      budget,
      mutate,
      signal,
      ctx,
      onUpdate,
    });
  });
}

/** A mutation tool's own parameters; executeMutation separates then_run. */
type MutationParams<P extends TProperties> = Static<TObject<P>> & { readonly path: string };

/** What a mutation tool supplies to the shared definition; renderers stay with the tool. */
interface MutationToolBaseSpec<P extends TProperties, TDetails, TTool extends MutationToolName>
  extends MutationToolSpec<MutationParams<P>, TDetails, TTool> {
  /** Parameters without then_run, which Action Fusion adds. */
  readonly schema: TObject<P>;
  readonly description: string;
  readonly promptSnippet: string;
  readonly promptGuidelines?: readonly string[];
  /** Semantic argument checks the schema cannot express. */
  readonly check?: CheckArguments;
}

/**
 * The definition every mutation tool shares. Action Fusion adds then_run to the
 * schema, description, and guidelines only when it is on; arguments are prepared
 * against the parameters Pi registers; execution runs through executeMutation.
 */
export function mutationToolBase<
  P extends TProperties,
  TDetails extends object,
  TTool extends MutationToolName,
>(spec: MutationToolBaseSpec<P, TDetails, TTool>) {
  const { tool, schema, fusion, budgets } = spec;
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
    ) {
      return executeMutation(spec, { toolCallId, params, signal, onUpdate, ctx });
    },
  };
}

/** A whole-file text transformation produced from one snapshot. */
export interface TextChange<TTool extends MutationToolName> {
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

  const commit = await commitReplacement(absolutePath, next.text, baseRevision, signal);
  return postProcessMutation(commit.publication, () => ({
    commit,
    details: generateMutationDetails(currentText, next.text),
    facts: next.facts,
  }));
}
