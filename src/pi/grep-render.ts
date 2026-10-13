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
  const out: string[] = [];
  const lines = raw.split("\n");
  const lineNoWidth = lines.reduce(
    (width, line) => Math.max(width, parseDisplayRow(line)?.lineNo.length ?? 0),
    0,
  );
  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    const header = parseFileHeader(line);
    if (header) {
      out.push(theme.fg("success", header.path) + theme.fg("dim", ` · ${header.summary}`));
      // The file's rows follow its header until the first line that is not a row.
      const group: { lineNo: string; content: string }[] = [];
      let next = index + 1;
      while (next < lines.length) {
        const row = parseDisplayRow(lines[next]);
        if (!row) break;
        group.push({ lineNo: row.lineNo, content: row.content });
        next++;
      }
      // Indentation shared by every row is folded into one marker.
      const base = group.length ? Math.min(...group.map(({ content }) => indentation(content))) : 0;
      const marker = base > 0 ? theme.fg("dim", "›") + " " : "";
      for (const { lineNo, content } of group) {
        out.push(
          theme.fg("dim", `   ${lineNo.padStart(lineNoWidth)}: `) +
            marker +
            theme.fg("toolOutput", content.slice(base)),
        );
      }
      index = next;
      continue;
    }
    out.push(theme.fg("toolOutput", line));
    index++;
  }
  return out;
}
