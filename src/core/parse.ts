/**
 * Strict parser: patch string → {@link ParsedPatch}.
 *
 * Core principle — zero guessing: only the canonical format is accepted (correct
 * verb + correct anchor + `+` body rows). Any variant (bare lines, legacy
 * `oldText`/`newText`, `SWAP`/`DEL`, etc.) is rejected and left to the
 * `transforms/normalize-legacy` middleware to normalize before parsing.
 *
 * Format:
 *
 * ```
 * file: <path>
 *
 * replace <line>#<hash>[..<line>#<hash>]:
 * +<text>
 *
 * delete <line>#<hash>[..<line>#<hash>]
 *
 * insert_after <line>#<hash>:
 * +<text>
 *
 * append:
 * +<text>
 * ```
 *
 * @module pi-hashline-edit/core
 */

import type { Anchor, Edit, ParsedPatch, PatchError } from "./types.ts";

export type ParseResult =
	| { readonly ok: true; readonly patch: ParsedPatch }
	| { readonly ok: false; readonly error: PatchError };

function parseError(message: string, line?: number): PatchError {
	return { kind: "parse", message, line };
}

const ANCHOR_RE = /^(\d+)#([0-9A-Za-z]+)$/;

function parseAnchorStr(s: string): Anchor | null {
	const m = ANCHOR_RE.exec(s);
	return m ? { line: Number(m[1]), hash: m[2] } : null;
}

function parseRangeStr(s: string): { start: Anchor; end?: Anchor } | null {
	const idx = s.indexOf("..");
	if (idx === -1) {
		const a = parseAnchorStr(s);
		return a ? { start: a } : null;
	}
	const a = parseAnchorStr(s.slice(0, idx));
	const b = parseAnchorStr(s.slice(idx + 2));
	if (!a || !b) return null;
	return { start: a, end: b };
}

type ParsedHeader =
	| { readonly error: string }
	| {
			readonly verb: string;
			readonly hasBody: boolean;
			readonly build: (body: string[]) => Edit;
	  };

/** Parse a single operation header (already trimmed). Trailing colon is optional (for body-bearing verbs). */
function parseOpHeader(s: string): ParsedHeader {
	let core = s;
	if (core.endsWith(":")) core = core.slice(0, -1).trimEnd();

	const sp = core.indexOf(" ");
	const verb = sp === -1 ? core : core.slice(0, sp);
	const rest = sp === -1 ? "" : core.slice(sp + 1).trim();

	switch (verb) {
		case "replace": {
			const r = parseRangeStr(rest);
			if (!r) return { error: `replace needs "<line>#<hash>[..<line>#<hash>]", got: "${s}"` };
			return { verb, hasBody: true, build: (body) => ({ op: "replace", start: r.start, end: r.end, body }) };
		}
		case "delete": {
			const r = parseRangeStr(rest);
			if (!r) return { error: `delete needs "<line>#<hash>[..<line>#<hash>]", got: "${s}"` };
			return { verb, hasBody: false, build: () => ({ op: "delete", start: r.start, end: r.end }) };
		}
		case "insert_after":
		case "insert_before": {
			const a = parseAnchorStr(rest);
			if (!a) return { error: `${verb} needs "<line>#<hash>", got: "${s}"` };
			return { verb, hasBody: true, build: (body) => ({ op: verb, anchor: a, body }) };
		}
		case "append":
		case "prepend": {
			if (rest !== "") return { error: `${verb} takes no anchor, got: "${s}"` };
			return { verb, hasBody: true, build: (body) => ({ op: verb, body }) };
		}
		default:
			return {
				error: `unknown verb "${verb}". Use replace / delete / insert_after / insert_before / append / prepend`,
			};
	}
}

/**
 * Strictly parse a patch.
 *
 * @param input patch string (CRLF is normalized to LF automatically)
 * @returns parse result; malformed input returns `ok: false` + PatchError (with the input line number)
 */
export function parsePatch(input: string): ParseResult {
	const normalized = input.replace(/\r\n/g, "\n");
	const lines = normalized.split("\n");
	const n = lines.length;
	let i = 0;

	while (i < n && lines[i].trim() === "") i++;
	if (i >= n) return { ok: false, error: parseError("empty input", 1) };

	const fileMatch = /^file:\s*(.+?)\s*$/i.exec(lines[i]);
	if (!fileMatch) {
		return {
			ok: false,
			error: parseError(`expected "file: <path>" on first non-blank line, got: "${lines[i]}"`, i + 1),
		};
	}
	const path = fileMatch[1];
	i++;

	const edits: Edit[] = [];
	while (i < n) {
		while (i < n && lines[i].trim() === "") i++;
		if (i >= n) break;

		const headerLineNo = i + 1;
		const raw = lines[i];
		const trimmed = raw.trim();

		if (trimmed.startsWith("+")) {
			return { ok: false, error: parseError(`stray body row has no preceding header: "${raw}"`, headerLineNo) };
		}

		const parsed = parseOpHeader(trimmed);
		if ("error" in parsed) {
			return { ok: false, error: parseError(parsed.error, headerLineNo) };
		}
		i++;

		let body: string[] = [];
		if (parsed.hasBody) {
			while (i < n && lines[i].startsWith("+")) {
				body.push(lines[i].slice(1));
				i++;
			}
			if (body.length === 0) {
				return {
					ok: false,
					error: parseError(`"${parsed.verb}" needs at least one "+TEXT" body row`, headerLineNo),
				};
			}
		}

		edits.push(parsed.build(body));
	}

	return { ok: true, patch: { path, edits } };
}
