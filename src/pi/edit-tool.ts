/**
 * Override edit: hashline ops via structured `edits` (LINE#HASH anchors).
 *
 * Each op in `edits` references line anchors copied from read / grep / replace output
 * (or from a prior edit's "Updated anchors"). The core verifies each anchor live against
 * the current file content — no snapshot, no global stale check: a cited line
 * that changed (or was misremembered) fails its own anchor; unchanged lines
 * elsewhere never block the edit. Legacy oldText/newText is not accepted — the
 * schema requires an `op` discriminator, so legacy payloads are rejected at the
 * schema layer (a visible failure, never a silent degradation).
 *
 * On success the result carries fresh `LINE#HASH` anchors for the lines this
 * edit produced (and the line that shifted into a deletion gap), so the model
 * can chain edits without a re-read.
 *
 * Concurrency safety: read-modify-write is wrapped in withFileMutationQueue.
 * AbortSignal is honored — checked after read / before write.
 *
 * @module pi-hashline-edit/pi
 */

import { generateDiffString, generateUnifiedPatch, truncateHead, withFileMutationQueue, type EditToolDetails } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { Text } from "@earendil-works/pi-tui";
import { readFile } from "node:fs/promises";
import { ACTION_FUSION_GUIDELINES, createActionFusionExecutor, createThenRunSchema, type ThenRunInput } from "./action-fusion.ts";
import { byteRevision, commitFile, FileMutationError, type MutationVersions, type PublicationStatus } from "./file-commit.ts";
import { applyEdits, decodeEditableText } from "../core/index.ts";
import { splitLines } from "../core/lines.ts";
import type { ApplyFailure, Edit } from "../core/types.ts";
import { canonicalPath } from "./read-tool.ts";
import { getState } from "./state.ts";
import { formatDiffCounts, renderMutationResult, type DiffCounts } from "./render.ts";
import { formatFailureContext, formatUniqueCandidateNeighborhoods, MAX_RECOVERY_CANDIDATE_BYTES } from "./failure-context.ts";
import { finalizeMutationResult, formatMutationAnchors } from "./mutation-result.ts";

/** Cap failure details and status rows independently; each text block also has a byte cap. */
const MAX_FAILURE_DETAILS = 40;

const ANCHOR_PATTERN = "^([1-9][0-9]*)#([0-9A-Z]{2,8})$";

function anchorRef(description: string) {
	return Type.Optional(Type.String({ pattern: ANCHOR_PATTERN, description }));
}

/** Parse copied tokens at the boundary; core edits retain numeric anchors. */
function parseAnchor(value: string | undefined) {
	if (value === undefined) return undefined;
	const match = typeof value === "string" ? new RegExp(ANCHOR_PATTERN).exec(value) : null;
	if (!match || !Number.isSafeInteger(Number(match[1]))) {
		throw new Error('Invalid anchor; copy a complete "LINE#HASH" token from the latest tool result.');
	}
	return { line: Number(match[1]), hash: match[2] };
}

const editOpSchema = Type.Object({
	op: Type.Union(
		[
			Type.Literal("replace", { description: "Replace the cited line(s) with `body`." }),
			Type.Literal("delete", { description: "Delete the cited line(s)." }),
			Type.Literal("insert_after", {
				description: "Insert `body` immediately after the anchor line — the anchor line is kept as-is; do NOT copy it into `body`.",
			}),
			Type.Literal("insert_before", {
				description: "Insert `body` immediately before the anchor line — the anchor line is kept as-is; do NOT copy it into `body`.",
			}),
			Type.Literal("append", { description: "Append `body` at the end of the file." }),
			Type.Literal("prepend", { description: "Prepend `body` at the start of the file." }),
		],
		{ description: "Operation kind" },
	),
	anchor: anchorRef(
		'Copy "LINE#HASH" from the latest read, grep, or mutation result. Required for replace/delete/insert; omit for append/prepend.',
	),
	end: anchorRef(
		'Inclusive last "LINE#HASH" for replace/delete ranges. Required to change multiple existing lines; omitted means only the anchor line. Omit for insert/append/prepend.',
	),
	body: Type.Optional(Type.Array(Type.String({ pattern: "^[^\\r\\n]*$" }), { description: "New content lines (required for replace/insert/append/prepend; each element must be one logical line without CR/LF; omit for delete)" })),
});

function createEditSchema(actionFusion: boolean) {
	return Type.Object({
		path: Type.String({ description: "Path to the file to edit (relative or absolute)" }),
		edits: Type.Array(editOpSchema, { description: "Hashline ops, each referencing LINE#HASH anchors from your latest read or edit result" }),
		...(actionFusion ? { then_run: createThenRunSchema("Command to run after the edit succeeds; failure does not roll back the edit.") } : {}),
	});
}

const editSchema = createEditSchema(false);
type EditParams = Omit<Static<typeof editSchema>, "then_run"> & { then_run?: ThenRunInput };

type EditOpInput = Static<typeof editOpSchema>;

/** Format a failed batch with retryable shifted anchors and bounded live context. */
function formatFailureDetails(
	failure: ApplyFailure,
	snapshot: Readonly<{ currentText: string; hashLen: number }>,
	candidateLines: ReadonlySet<number>,
): string {
	if (failure.kind !== "anchor") return failure.message;

	const lines: string[] = [];
	const currentLines = splitLines(snapshot.currentText);
	const shownCandidates = new Set(candidateLines);
	let found = 0;
	let ambiguous = 0;
	let none = 0;
	for (const f of failure.failures) {
		if (f.recovery.kind === "found") found++;
		else if (f.recovery.kind === "ambiguous") ambiguous++;
		else none++;
		if (lines.length >= MAX_FAILURE_DETAILS) continue;
		const where = `op #${f.opIndex} ${f.op} ${f.which} (line ${f.cited.line})`;
		switch (f.recovery.kind) {
			case "found": {
				const content = currentLines[f.recovery.newLine - 1];
				const row = `${f.recovery.newLine}#${f.recovery.newHash}│${content}`;
				let detail = `• ${where}: checksum-matching candidate ${f.recovery.newLine}#${f.recovery.newHash}.`;
				if (!shownCandidates.has(f.recovery.newLine)) {
					if (content !== undefined && Buffer.byteLength(row, "utf8") <= MAX_RECOVERY_CANDIDATE_BYTES) {
						detail += `\n${row}`;
						shownCandidates.add(f.recovery.newLine);
					} else {
						detail += ` Candidate content exceeds ${MAX_RECOVERY_CANDIDATE_BYTES} bytes.`;
					}
				}
				lines.push(detail);
				break;
			}
			case "ambiguous": {
				const list = f.recovery.candidates.slice(0, 8).map((candidate) => `"${candidate.line}#${candidate.hash}"`).join(" / ");
				const more = f.recovery.candidates.length > 8 ? ` (${f.recovery.candidates.length - 8} more candidates omitted)` : "";
				lines.push(`• ${where}: ambiguous checksum matches: ${list}${more}.`);
				break;
			}
			case "none":
				lines.push(
					`• ${where}: original content not found within the configured shift-recovery window.` +
						(f.current === null ? " Cited line is out of range." : ""),
				);
				break;
		}
	}
	const parts: string[] = [];
	if (found) parts.push(`${found} shifted`);
	if (ambiguous) parts.push(`${ambiguous} ambiguous`);
	if (none) parts.push(`${none} unresolved`);
	const message = [
		`Anchor mismatch: ${parts.join(", ")}.`,
		"No changes written by this edit batch.",
		...lines,
		...(failure.failures.length > lines.length ? [`${failure.failures.length - lines.length} failure details omitted.`] : []),
	].join("\n") + formatFailureContext(snapshot.currentText, failure.failures, snapshot.hashLen);
	const notice = "\nDiagnostic output truncated at 16 KiB.";
	const bounded = truncateHead(message, { maxBytes: 16 * 1024 - Buffer.byteLength(notice) });
	return bounded.content + (bounded.truncated ? notice : "");
}

function formatAnchorChecks(failure: ApplyFailure): string {
	const rows = failure.checks.slice(0, MAX_FAILURE_DETAILS).map((check) =>
		`op ${check.opIndex} / ${check.which} / ${check.cited.line}#${check.cited.hash} / ${check.status}`,
	);
	const omitted = failure.checks.length - rows.length;
	const message = [
		"Input-anchor checks (this snapshot):",
		...rows,
		...(omitted ? [`Anchor checks: ${rows.length}/${failure.checks.length}; ${omitted} omitted.`] : []),
		"Anchor checks only; retries revalidate.",
	].join("\n");
	const notice = "\nAnchor-check output truncated at 16 KiB; omitted entries are not implied matched.";
	const bounded = truncateHead(message, { maxBytes: 16 * 1024 - Buffer.byteLength(notice) });
	return bounded.content + (bounded.truncated ? notice : "");
}

/** Keep validation status and observation context visible even when failure details are truncated. */
function formatFailure(
	failure: ApplyFailure,
	snapshot: Readonly<{ currentText: string; hashLen: number }>,
): string {
	const candidateNeighborhoods = failure.kind === "anchor"
		? formatUniqueCandidateNeighborhoods(snapshot.currentText, failure.failures, snapshot.hashLen)
		: { text: "", shownLines: new Set<number>() };
	const guidance = failure.kind === "anchor"
		? "\nCheck the intended target before retrying; use read or grep for omitted or additional context." : "";
	return `${formatFailureDetails(failure, snapshot, candidateNeighborhoods.shownLines)}\n${formatAnchorChecks(failure)}${candidateNeighborhoods.text}${guidance}`;
}

/** Translate JSON edit ops into core Edit[]. Validates conditional required fields (anchor/body per op). */
function toCoreEdits(ops: readonly EditOpInput[]): { ok: true; edits: Edit[] } | { ok: false; error: string } {
	const edits: Edit[] = [];
	for (const o of ops) {
		const anchor = parseAnchor(o.anchor);
		const end = parseAnchor(o.end);
		if (o.op !== "replace" && o.op !== "delete" && end) return { ok: false, error: `${o.op} does not accept \`end\`` };
		if ((o.op === "append" || o.op === "prepend") && anchor) return { ok: false, error: `${o.op} does not accept \`anchor\`` };
		if (o.op === "delete" && o.body !== undefined) return { ok: false, error: "delete does not accept `body`" };
		switch (o.op) {
			case "replace":
				if (!anchor) return { ok: false, error: 'replace needs `anchor` "LINE#HASH"' };
				if (!o.body) return { ok: false, error: "replace needs `body`" };
				edits.push({ op: "replace", start: anchor, end, body: o.body });
				break;
			case "delete":
				if (!anchor) return { ok: false, error: 'delete needs `anchor` "LINE#HASH"' };
				edits.push({ op: "delete", start: anchor, end });
				break;
			case "insert_after":
			case "insert_before":
				if (!anchor) return { ok: false, error: `${o.op} needs \`anchor\` "LINE#HASH"` };
				if (!o.body) return { ok: false, error: `${o.op} needs \`body\`` };
				edits.push({ op: o.op, anchor, body: o.body });
				break;
			case "append":
			case "prepend":
				if (!o.body) return { ok: false, error: `${o.op} needs \`body\`` };
				edits.push({ op: o.op, body: o.body });
				break;
		}
	}
	return { ok: true, edits };
}

/**
 * Format the updated anchors (fresh LINE#HASH│content) for the touched new-file
 * lines, so the model can chain edits without a re-read. Capped to bound tokens.
 */
function formatUpdatedAnchors(newText: string, touched: readonly number[], hashLen: number): string {
	const idxs = [...new Set(touched)].sort((a, b) => a - b);
	return formatMutationAnchors(splitLines(newText), idxs, hashLen, "Updated anchors (use these for the next edit):");
}

/** Call-header line: `edit path — N ops: op`, plus `+N -N` once the result's diff counts are known. */
function editHeader(args: any, theme: any, counts?: DiffCounts): string {
	let t = theme.fg("toolTitle", theme.bold("edit "));
	t += theme.fg("accent", args.path);
	const n = args.edits?.length ?? 0;
	if (n) t += theme.fg("dim", ` — ${n} op${n > 1 ? "s" : ""}: ${args.edits[0].op}`);
	if (counts && (counts.added || counts.removed)) t += formatDiffCounts(counts, theme);
	return t;
}

export function makeEditOverride(cwd: string, fusion?: ReturnType<typeof createActionFusionExecutor>): any {
	const parameters = createEditSchema(fusion !== undefined);

	return {
		name: "edit" as const,
		label: "edit",
		description:
			"Edit file lines using content-verified anchors. Returns fresh anchors for subsequent edits. Anchor failures report input-anchor status and bounded current-file context. Inspect recovery candidates before retrying; retries always revalidate anchors and never run automatically.",
		promptSnippet: "Edit file lines using verified anchors",
		promptGuidelines: [
			"Batch changes to the same file in one edit call.",
			"Use the latest returned anchors for subsequent edits; read again only for lines not covered by those results.",
			...(fusion ? ACTION_FUSION_GUIDELINES : []),
		],
		parameters,
		renderShell: "default" as const,

		renderCall(args: EditParams, theme: any, context: any) {
			const text = (context?.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			// Stash the header for renderResult: the diff counts land after
			// execution and are refreshed in place (renderResult's lastComponent
			// is the result component, not this header)
			if (context?.state) context.state.callText = text;
			text.setText(editHeader(args, theme, context?.state?.diffCounts));
			return text;
		},

		renderResult(result: any, options: any, theme: any, context: any) {
			return renderMutationResult(result, options, theme, context, "Editing…", "Edited", editHeader);
		},

		async execute(toolCallId: string, params: EditParams, signal: AbortSignal | undefined, onUpdate: any, ctx: any) {
			const { then_run, ...mutationParams } = params;
			if (!fusion && then_run !== undefined) throw new Error("then_run is unavailable because hashlineEdit.actionFusion is disabled");
			const absolutePath = canonicalPath(cwd, mutationParams.path);
			let mutationAnchors = "";
			const mutate = () => {
				const path = mutationParams.path;
				if (!mutationParams.edits?.length) throw new Error(`Edit ${path}: \`edits\` is empty or missing.`);
				return withFileMutationQueue(absolutePath, () => runHashline(
					absolutePath,
					path,
					mutationParams.edits,
					signal,
					(anchors) => { mutationAnchors = anchors; },
				));
			};
			const finalizeMutation = (result: any, publishAnchors: boolean) => ({
				...result,
				content: result.content.map((block: any, index: number) =>
					index === 0 && block.type === "text"
						? { ...block, text: `${block.text}${publishAnchors ? mutationAnchors : ""}` }
						: block,
				),
			});
			if (!fusion) return finalizeMutationResult(await mutate(), finalizeMutation);
			return fusion({
				toolCallId,
				absolutePath,
				thenRun: then_run,
				mutate,
				finalizeMutation,
				signal,
				ctx,
				onUpdate,
			});
		},
	};
}

async function runHashline(
	absPath: string,
	displayPath: string,
	editOps: readonly EditOpInput[],
	signal: AbortSignal | undefined,
	onAnchors: (anchors: string) => void,
) {
	const { hashLen, shiftRadius } = getState().config;

	let currentText: string;
	let baseRevision: string;
	try {
		const currentBytes = await readFile(absPath);
		baseRevision = byteRevision(currentBytes);
		currentText = decodeEditableText(currentBytes);
	} catch (e) {
		const msg = e instanceof Error ? e.message : String(e);
		throw new Error(`Error reading ${displayPath}: ${msg}`);
	}
	// Check for cancel after read: if the user aborted, don't proceed to parse/apply; the file stays untouched
	if (signal?.aborted) throw new Error(`Edit ${displayPath} aborted before apply.`);

	const translated = toCoreEdits(editOps);
	if (!translated.ok) throw new Error(translated.error);

	// Anchors are verified against the current content. A line that changed (or a
	// hash the model didn't actually read) fails its own anchor — but first we try
	// shifted recovery: if the content merely moved within ±shiftRadius, a fresh
	// anchor is returned so the model can retry without a re-read. All failures in
	// the batch are collected (nothing written on any failure).
	const result = applyEdits(currentText, translated.edits, hashLen, shiftRadius);
	if (!result.ok) {
		throw new Error(formatFailure(result.failure, { currentText, hashLen }));
	}

	// Check for cancel before write: if aborted, don't touch the disk; the file stays untouched
	if (signal?.aborted) throw new Error(`Edit ${displayPath} aborted before write.`);

	let publication: PublicationStatus = "NOT_PUBLISHED";
	let versions: MutationVersions;
	try {
		const commit = await commitFile(absPath, result.text, { mode: "overwrite", expectedRevision: baseRevision, signal });
		publication = commit.publication;
		versions = commit;
	} catch (e) {
		if (e instanceof FileMutationError) throw e;
		throw new FileMutationError("commit", "UNKNOWN", `Error writing ${displayPath}: ${e instanceof Error ? e.message : String(e)}`, { cause: e });
	}

	let details: EditToolDetails & MutationVersions & { publication: PublicationStatus; revision: string };
	let anchors: string;
	try {
		// Diff and anchor generation happens after publication; preserve that state on failure.
		const oldLf = currentText.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
		const newLf = result.text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
		const { diff, firstChangedLine } = generateDiffString(oldLf, newLf);
		details = {
			diff,
			patch: generateUnifiedPatch(displayPath, oldLf, newLf),
			firstChangedLine,
			publication,
			...versions,
			revision: versions.publishedRevision,
		};
		anchors = formatUpdatedAnchors(result.text, result.touchedLines, hashLen);
		onAnchors(anchors);
	} catch (error) {
		throw new FileMutationError("post_process", publication, `file was published but edit result generation failed: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
	}
	return {
		content: [{ type: "text" as const, text: `Edited ${displayPath} (${translated.edits.length} op(s)).` }],
		details,
	};
}
