import type { Theme } from "@earendil-works/pi-coding-agent";
import { parseDisplayRow } from "./anchor-format.ts";
import { parseFileHeader } from "./grep-output.ts";

function countLeading(s: string): number {
  const m = s.match(/^[ \t]*/);
  return m ? m[0].length : 0;
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
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const header = parseFileHeader(line);
    if (header) {
      out.push(theme.fg("success", header.path) + theme.fg("dim", ` · ${header.summary}`));
      // collect the anchor lines in this file group
      const group: { lineNo: string; content: string }[] = [];
      let j = i + 1;
      while (j < lines.length) {
        const a = parseDisplayRow(lines[j]);
        if (!a) break;
        group.push({ lineNo: a.lineNo, content: a.content });
        j++;
      }
      // common base = min leading whitespace across the group; fold it into a marker
      const base = group.length ? Math.min(...group.map((g) => countLeading(g.content))) : 0;
      const marker = base > 0 ? theme.fg("dim", "›") + " " : "";
      for (const g of group) {
        const body = g.content.slice(base);
        out.push(
          theme.fg("dim", `   ${g.lineNo.padStart(lineNoWidth)}: `) +
            marker +
            theme.fg("toolOutput", body),
        );
      }
      i = j;
      continue;
    }
    out.push(theme.fg("toolOutput", line));
    i++;
  }
  return out;
}
