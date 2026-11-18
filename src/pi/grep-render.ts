/**
 * grep's TUI rows: file headers and their aligned, indentation-folded match rows.
 *
 * @module pi-hashline-edit/pi
 */
import type { Theme } from "@earendil-works/pi-coding-agent";
import { parseDisplayRow } from "./anchor-format.ts";
import { parseFileHeader } from "./grep-output.ts";

/** Leading spaces and tabs of a row's content. */
function indentation(text: string): number {
  return /^[ \t]*/.exec(text)![0].length;
}

/**
 * Render grouped grep results for the TUI. Anchored and plain preview rows share
 * aligned line numbers and folded leading indentation; anchored rows lose their
 * hashes. Notices are report facts, which the card renders from the report.
 */
export function toDisplayLines(raw: string, theme: Theme): string[] {
  const lines = raw.split("\n");
  type Header = NonNullable<ReturnType<typeof parseFileHeader>>;
  type Row = NonNullable<ReturnType<typeof parseDisplayRow>>;
  const blocks: (string | { header: Header; rows: Row[] })[] = [];
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
    const rows: Row[] = [];
    while (index + 1 < lines.length) {
      const row = parseDisplayRow(lines[index + 1]);
      if (!row) break;
      rows.push(row);
      lineNoWidth = Math.max(lineNoWidth, row.lineNo.length);
      index++;
    }
    blocks.push({ header, rows });
  }

  const out: string[] = [];
  for (const group of blocks) {
    if (typeof group === "string") {
      out.push(theme.fg("toolOutput", group));
      continue;
    }
    const { path, summary } = group.header;
    out.push(theme.fg("success", path) + theme.fg("dim", ` · ${summary}`));
    // Fold shared indentation without spreading an unbounded number of rows.
    const base = group.rows.length
      ? group.rows.reduce((min, { content }) => Math.min(min, indentation(content)), Infinity)
      : 0;
    const marker = base > 0 ? theme.fg("dim", "›") + " " : "";
    for (const { lineNo, content } of group.rows) {
      out.push(
        theme.fg("dim", `   ${lineNo.padStart(lineNoWidth)}: `) +
          marker +
          theme.fg("toolOutput", content.slice(base)),
      );
    }
  }
  return out;
}
