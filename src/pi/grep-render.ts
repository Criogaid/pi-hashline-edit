import type { Theme } from "@earendil-works/pi-coding-agent";
import { parseHashline } from "./anchor-format.ts";
import { isNoticeLine, parseFileHeader } from "./grep-output.ts";

/**
 * Render grouped grep results for the TUI. Anchored rows lose their hashes and
 * share folded leading indentation; plain preview rows pass through unchanged.
 * The model receives the original content text, including preview notices.
 */
function countLeading(s: string): number {
  const m = s.match(/^[ \t]*/);
  return m ? m[0].length : 0;
}

export function toDisplayLines(raw: string, theme: Theme): string[] {
  const out: string[] = [];
  const lines = raw.split("\n");
  const lineNoWidth = lines.reduce(
    (width, line) => Math.max(width, parseHashline(line)?.lineNo.length ?? 0),
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
        const a = parseHashline(lines[j]);
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
    if (isNoticeLine(line)) out.push(theme.fg("warning", line));
    else out.push(theme.fg("toolOutput", line));
    i++;
  }
  return out;
}
