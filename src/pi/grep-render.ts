import type { Theme } from "@earendil-works/pi-coding-agent";
import { parseHashline } from "./render.ts";

/**
 * Convert the anchored grep output (grouped, `LINE#HASH│`) into a human-readable
 * form for the TUI: drop the hash, keep file headers and line numbers. Within each
 * file group, the common leading whitespace shared by all matched lines is folded
 * into a single marker (›) so deep, repeated indentation doesn't eat display width;
 * each line's indentation relative to that common base is preserved. The model still
 * receives the anchored `content` text verbatim — this only affects what the user sees.
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
    const h = line.match(/^(.+?) · (\d+ match(?:es)?)$/);
    if (h) {
      out.push(theme.fg("success", h[1]) + theme.fg("dim", ` · ${h[2]}`));
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
    if (line.startsWith("[")) out.push(theme.fg("warning", line));
    else out.push(theme.fg("toolOutput", line));
    i++;
  }
  return out;
}
