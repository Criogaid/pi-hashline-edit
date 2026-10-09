/**
 * Shared execution pipeline for the file mutation tools (edit, replace, write).
 *
 * Owns the sequencing every mutation tool must keep identical once Pi has
 * prepared and validated the arguments: separating then_run, path resolution,
 * the shared file mutation queue, and the hand-off to Action Fusion or plain
 * finalization. Each tool
 * returns a typed `MutationOutcome` (result, commit facts, anchors); nothing
 * downstream reads publication or revisions back from result details. Every
 * failure leaves as one error record with the call's path, stage, and publication.
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
  createActionFusionExecutor,
  MutationToolName,
  ThenRunInput,
} from "./action-fusion.ts";
import {
  commitReplacement,
  readEditableSnapshot,
  commitFreshness,
  mutationFact,
} from "./file-commit.ts";
import { emptyReport, type ReportDetails } from "./report.ts";
import type { AnchorReport, ToolReport } from "../core/report-schema.ts";
import {
  finalizeMutation,
  generateMutationDetails,
  postProcessMutation,
  type MutationOutcome,
} from "./mutation-result.ts";
import { canonicalPath } from "./path.ts";
import { throwIfCancelled } from "./error-text.ts";
import { reportToolErrors } from "./tool-error.ts";

export type ActionFusionExecutor = ReturnType<typeof createActionFusionExecutor>;

/** Result details shared by the read-modify-write tools. */
export type TextMutationDetails = ReturnType<typeof generateMutationDetails>;

/** The file a mutation targets, resolved once per call. */
export interface MutationTarget {
  readonly tool: MutationToolName;
  readonly absolutePath: string;
  /** The caller-supplied path, used in result text and diffs. */
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
export async function executeMutation<TParams extends { path: string }, TDetails>(
  spec: MutationToolSpec<TParams, TDetails>,
  call: MutationCall<TParams, TDetails>,
): Promise<AgentToolResult<(TDetails & ReportDetails) | ReportDetails>> {
  const { cwd, fusion } = spec;
  const { toolCallId, signal, onUpdate, ctx } = call;
  const { then_run, ...mutationParams } = call.params;
  const displayPath = mutationParams.path;
  return reportToolErrors(spec.tool, { path: displayPath, mutation: true, signal }, async () => {
    const absolutePath = canonicalPath(cwd, displayPath);
    const target: MutationTarget = { tool: spec.tool, absolutePath, displayPath, signal };
    const mutate = (): Promise<MutationOutcome<TDetails>> =>
      withFileMutationQueue(absolutePath, () =>
        spec.run(mutationParams as unknown as TParams, target),
      );
    if (!fusion) {
      const outcome = await mutate();
      return finalizeMutation(outcome, { freshness: commitFreshness(outcome.commit) });
    }
    return fusion({
      toolCallId,
      tool: spec.tool,
      displayPath,
      absolutePath,
      thenRun: then_run,
      mutate,
      signal,
      ctx,
      onUpdate,
    });
  });
}

/** A whole-file text transformation produced from one snapshot. */
export interface TextChange {
  /** Complete replacement text; equal to the snapshot for a no-op. */
  readonly text: string;
  /** Fresh anchor report for the committed text. Called during result generation. */
  anchors(): AnchorReport | undefined;
  readonly facts: Pick<ToolReport, "edit" | "replace">;
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

  const versions = await commitReplacement(absolutePath, next.text, baseRevision, signal);
  let anchors: AnchorReport | undefined;
  const result = postProcessMutation(versions.publication, () => {
    const details = generateMutationDetails(displayPath, currentText, next.text);
    anchors = next.anchors();
    return {
      content: [],
      details: {
        ...details,
        report: {
          ...emptyReport(target.tool),
          path: displayPath,
          mutation: mutationFact(versions),
          ...next.facts,
        },
      },
    };
  });
  return { result, commit: versions, anchors };
}
