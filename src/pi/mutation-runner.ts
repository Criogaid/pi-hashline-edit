/**
 * Shared execution pipeline for the file mutation tools (edit, replace, write).
 *
 * Owns the sequencing every mutation tool must keep identical once Pi has
 * prepared and validated the arguments: separating then_run, path resolution,
 * the shared file mutation queue, and the hand-off to Action Fusion or plain
 * finalization. Each tool
 * returns a typed `MutationOutcome` (commit facts, details, outcome facts,
 * anchors); `finalizeMutation` alone turns it into the result, so nothing
 * downstream reads publication or revisions back from result details. Every
 * failure leaves as one report with the call's path, stage, and publication.
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
import type {
  ActionFusionDetails,
  createActionFusionExecutor,
  MutationToolName,
  ThenRunInput,
} from "./action-fusion.ts";
import { commitFreshness, commitReplacement, readEditableSnapshot } from "./file-commit.ts";
import {
  finalizeMutation,
  generateMutationDetails,
  postProcessMutation,
  type AnchorReport,
  type MutationOutcome,
} from "./mutation-result.ts";
import { canonicalPath } from "./path.ts";
import { throwIfCancelled } from "./error-text.ts";
import { runTool, type ReportDetails } from "./report.ts";

export type ActionFusionExecutor = ReturnType<typeof createActionFusionExecutor>;

/** Result details shared by the read-modify-write tools. */
export type TextMutationDetails = ReturnType<typeof generateMutationDetails> & {
  actionFusion?: ActionFusionDetails;
};

/** The file a mutation targets, resolved once per call. */
export interface MutationTarget {
  readonly absolutePath: string;
  /** The caller-supplied path, used in reports and diffs. */
  readonly displayPath: string;
  readonly signal: AbortSignal | undefined;
}

export interface MutationToolSpec<TParams extends { path: string }, TDetails> {
  readonly tool: MutationToolName;
  readonly cwd: string;
  readonly fusion: ActionFusionExecutor | undefined;
  /** Perform the mutation. Runs inside the file mutation queue. */
  run(params: TParams, target: MutationTarget): Promise<MutationOutcome<TDetails>>;
}

export interface MutationCall<TParams, TDetails> {
  readonly toolCallId: string;
  /** Arguments already prepared and validated by Pi against the tool schema. */
  readonly params: TParams & { then_run?: ThenRunInput };
  readonly signal: AbortSignal | undefined;
  readonly onUpdate: AgentToolUpdateCallback<TDetails> | undefined;
  readonly ctx: ExtensionToolContext;
}

/** Queue and publish one validated mutation call, then run its then_run command when fused. */
export async function executeMutation<TParams extends { path: string }, TDetails extends object>(
  spec: MutationToolSpec<TParams, TDetails>,
  call: MutationCall<TParams, TDetails>,
): Promise<AgentToolResult<TDetails & Partial<ReportDetails>>> {
  const { cwd, fusion, tool } = spec;
  const { toolCallId, signal, onUpdate, ctx } = call;
  const { then_run, ...mutationParams } = call.params;
  const displayPath = mutationParams.path;
  const result = await runTool(tool, { path: displayPath, mutation: true, signal }, async () => {
    const absolutePath = canonicalPath(cwd, displayPath);
    const target: MutationTarget = { absolutePath, displayPath, signal };
    const mutate = (): Promise<MutationOutcome<TDetails>> =>
      withFileMutationQueue(absolutePath, () =>
        spec.run(mutationParams as unknown as TParams, target),
      );
    if (!fusion) {
      const outcome = await mutate();
      return finalizeMutation(tool, displayPath, outcome, commitFreshness(outcome.commit));
    }
    return fusion({
      toolCallId,
      tool,
      displayPath,
      absolutePath,
      thenRun: then_run,
      mutate,
      signal,
      ctx,
      onUpdate,
    });
  });
  return result as AgentToolResult<TDetails & Partial<ReportDetails>>;
}

/** A whole-file text transformation produced from one snapshot. */
export interface TextChange {
  /** Complete replacement text; equal to the snapshot for a no-op. */
  readonly text: string;
  /** Fresh anchor report for the committed text. Called during result generation. */
  anchors(): AnchorReport;
  /** The tool's own outcome facts, such as replace's match count. */
  readonly facts?: MutationOutcome<unknown>["facts"];
}

/**
 * Read-modify-write against the bytes read: the commit is rejected if the file
 * changed since the snapshot, and result-generation failures keep publication.
 */
export async function runTextMutation(
  target: MutationTarget,
  change: (currentText: string) => TextChange | Promise<TextChange>,
): Promise<MutationOutcome<TextMutationDetails>> {
  const { absolutePath, displayPath, signal } = target;

  const { text: currentText, baseRevision } = await readEditableSnapshot(absolutePath, signal);
  // Cancelled after read: don't transform; the file stays untouched.
  throwIfCancelled(signal);

  const next = await change(currentText);

  // Cancelled before write: don't touch the disk.
  throwIfCancelled(signal);

  const commit = await commitReplacement(absolutePath, next.text, baseRevision, signal);
  return postProcessMutation(commit.publication, () => ({
    commit,
    details: generateMutationDetails(
      displayPath,
      currentText,
      next.text,
      commit,
      commit.publication,
    ),
    facts: next.facts ?? {},
    anchors: next.anchors(),
  }));
}
