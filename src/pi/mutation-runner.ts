/**
 * Shared execution pipeline for the file mutation tools (edit, replace, write).
 *
 * `mutationToolBase` assembles the definition every mutation tool shares:
 * then_run's field and guideline when Action Fusion is on,
 * argument preparation, strict sampling, and execution. Each tool supplies its schema, text,
 * semantic checks, and `run`, and adds its own renderers.
 *
 * Owns the sequencing every mutation tool must keep identical once Pi has
 * prepared and validated the arguments: separating then_run, path resolution,
 * the shared file mutation queue, the hand-off to Action Fusion, and
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
import { ACTION_FUSION_GUIDELINES, withThenRunSchema, type ThenRunInput } from "./action-fusion.ts";
import { createArgumentPreparer, type CheckArguments } from "./argument-validation.ts";
import { SCRIPT_OUTPUT_SCHEMAS, type MutationToolName } from "./report-schema.ts";
import { commitFile, FileMutationError, readEditableSnapshot } from "./file-commit.ts";
import {
  describeMutationFailure,
  finalizeMutation,
  generateMutationDetails,
  type MutationOutcome,
  type MutationScheduler,
  type MutationFinalDetails,
  type MutationResultDetails,
  type MutationFacts,
} from "./mutation-result.ts";
import { canonicalPath } from "./path.ts";
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
  readonly signal: AbortSignal;
  readonly budget: OutputBudgets;
}

/** A mutation tool's own parameters; `execute` separates then_run. */
type MutationParams<P extends TProperties> = Static<TObject<P>> & { readonly path: string };

/** What a mutation tool supplies to the shared definition; renderers stay with the tool. */
interface MutationToolSpec<P extends TProperties, TDetails, TTool extends MutationToolName>
  extends MutationToolEnvironment {
  readonly tool: TTool;
  /** Parameters without then_run, which Action Fusion adds. */
  readonly schema: TObject<P>;
  readonly description: string;
  readonly promptSnippet: string;
  readonly promptGuidelines?: readonly string[];
  /** Semantic argument checks the schema cannot express. */
  readonly check: CheckArguments;
  /** Perform the mutation. Runs inside the file mutation queue. */
  run(
    params: Omit<MutationParams<P>, "then_run">,
    target: MutationTarget,
  ): Promise<MutationOutcome<TDetails, TTool>>;
}

/**
 * The definition every mutation tool shares. Action Fusion adds then_run to the
 * schema and guidelines only when it is on; arguments are prepared
 * against the parameters Pi registers; `execute` queues and publishes one
 * validated call, then runs its then_run command when fused.
 */
export function mutationToolBase<
  P extends TProperties,
  TDetails extends object,
  TTool extends MutationToolName,
>(spec: MutationToolSpec<P, TDetails, TTool>) {
  const { tool, cwd, schema, schedule, budgets } = spec;
  const { actionFusion } = spec.config;
  const parameters = withThenRunSchema(schema, tool, actionFusion);
  return {
    name: tool,
    label: tool,
    description: spec.description,
    promptSnippet: spec.promptSnippet,
    promptGuidelines: [
      ...(spec.promptGuidelines ?? []),
      ...(actionFusion ? ACTION_FUSION_GUIDELINES : []),
    ],
    parameters,
    outputSchema: SCRIPT_OUTPUT_SCHEMAS[tool],
    prepareArguments: createArgumentPreparer(tool, parameters, budgets, spec.check),
    constrainedSampling: STRICT_SAMPLING,
    renderShell: "default" as const,
    execute(
      toolCallId: string,
      params: MutationParams<P> & { then_run?: ThenRunInput },
      piSignal: AbortSignal | undefined,
      piOnUpdate: AgentToolUpdateCallback<MutationResultDetails<TDetails>> | undefined,
      ctx: ExtensionToolContext,
    ): Promise<AgentToolResult<MutationFinalDetails<TDetails>>> {
      const signal = callSignal(piSignal);
      // Pi's agent loop always supplies a callback; a direct call without one has no display.
      const onUpdate = piOnUpdate ?? (() => {});
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
          const settled = await schedule({
            toolCallId,
            absolutePath,
            thenRun: then_run,
            mutate,
            signal,
            ctx,
            onUpdate,
          });
          const result = finalizeMutation(tool, displayPath, settled, budget);
          // Pass on the session Bash result's request to stop after this tool batch.
          const terminate = settled.kind === "fused" ? settled.command.terminate : undefined;
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

  const commit = await commitFile(
    absolutePath,
    next.text,
    { mode: "update", baseRevision },
    signal,
  );
  try {
    return {
      commit,
      details: generateMutationDetails(currentText, next.text, next.copied),
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
