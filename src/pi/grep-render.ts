/**
 * grep's TUI rows: file headers and their aligned, indentation-folded match rows.
 *
 * @module pi-hashline-edit/pi
 */
import type { Theme } from "@earendil-works/pi-coding-agent";
import { parseDisplayRow } from "./anchor-format.ts";
import { CONTEXT_GAP, parseFileHeader } from "./grep-output.ts";

/** Leading spaces and tabs of a row's content. */
function indentation(text: string): number {
  return /^[ \t]*/.exec(text)![0].length;
}

/**
 * Render grouped grep results for the TUI. Anchored and plain preview rows share
 * aligned line numbers and folded leading indentation; anchored rows lose their
 * hashes, and a gap row keeps its place between two groups of one file. Notices are
 * report facts, which the card renders from the report.
 */
export function toDisplayLines(raw: string, theme: Theme): string[] {
  const lines = raw.split("\n");
  type Header = NonNullable<ReturnType<typeof parseFileHeader>>;
  type Row = NonNullable<ReturnType<typeof parseDisplayRow>>;
  const blocks: (string | { header: Header; rows: (Row | typeof CONTEXT_GAP)[]; base: number })[] =
    [];
  let lineNoWidth = 0;
  // A filename can look like a row, and a source row can end like a header.
  // Parse each group before measuring its rows so the header contributes no width.
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    const header = parseFileHeader(line);
    if (!header) {
      blocks.push(line);
      continue;
    }
    const rows: (Row | typeof CONTEXT_GAP)[] = [];
    let base = Infinity;
    while (index + 1 < lines.length) {
      // A gap row belongs to the group only when a row follows it.
      const gap = rows.length > 0 && lines[index + 1] === CONTEXT_GAP ? 1 : 0;
      const row = parseDisplayRow(lines[index + 1 + gap] ?? "");
      if (!row) break;
      if (gap) rows.push(CONTEXT_GAP);
      rows.push(row);
      base = Math.min(base, indentation(row.content));
      lineNoWidth = Math.max(lineNoWidth, row.lineNo.length);
      index += 1 + gap;
    }
    blocks.push({ header, rows, base });
  }

  const out: string[] = [];
  for (const group of blocks) {
    if (typeof group === "string") {
      out.push(theme.fg("toolOutput", group));
      continue;
    }
    const { path, summary } = group.header;
    out.push(theme.fg("success", path) + theme.fg("dim", ` · ${summary}`));
    const { base, rows } = group;
    const marker = base > 0 && rows.length ? theme.fg("dim", "›") + " " : "";
    for (const row of rows) {
      if (row === CONTEXT_GAP) {
        out.push(theme.fg("dim", `   ${CONTEXT_GAP}`));
        continue;
      }
      const { lineNo, content } = row;
      out.push(
        theme.fg("dim", `   ${lineNo.padStart(lineNoWidth)}: `) +
          marker +
          theme.fg("toolOutput", content.slice(base)),
      );
    }
  }
  return out;
}
