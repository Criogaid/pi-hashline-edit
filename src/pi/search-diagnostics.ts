/** One bounded diagnostic collection for partial-search successes and search failures. */
import type { SearchDiagnostic, SearchDiagnostics } from "../core/report-schema.ts";
import { MAX_SEARCH_DIAGNOSTIC_BYTES } from "./budgets.ts";
import { DiagnosticBuffer } from "./diagnostic-buffer.ts";

export class SearchDiagnosticBuffer {
  private entries: SearchDiagnostic[] = [];
  private total = 0;
  get length(): number {
    return this.total;
  }

  push(diagnostic: SearchDiagnostic): void {
    let entry = diagnostic;
    if (entry.kind === "process") {
      let budget = Math.floor(MAX_SEARCH_DIAGNOSTIC_BYTES / 2);
      const source = entry.stderr;
      const previouslyOmitted = entry.omittedBytes ?? 0;
      do {
        const buffer = new DiagnosticBuffer(budget);
        buffer.append(source);
        entry = {
          ...entry,
          stderr: buffer.toString(),
          ...(buffer.omittedBytes || previouslyOmitted
            ? { omittedBytes: previouslyOmitted + buffer.omittedBytes }
            : {}),
        };
        budget = Math.floor(budget / 2);
      } while (
        Buffer.byteLength(JSON.stringify(entry)) > MAX_SEARCH_DIAGNOSTIC_BYTES &&
        budget > 0
      );
    } else {
      const original = entry.causes;
      const previouslyOmitted = entry.omittedCauses ?? 0;
      let retained = original.length;
      while (
        Buffer.byteLength(JSON.stringify(entry)) > MAX_SEARCH_DIAGNOSTIC_BYTES &&
        retained > 0
      ) {
        retained--;
        const head = Math.ceil(retained / 2),
          tail = retained - head;
        entry = {
          ...entry,
          causes: [...original.slice(0, head), ...(tail ? original.slice(-tail) : [])],
          omittedCauses: previouslyOmitted + original.length - retained,
        };
      }
    }
    const encoded = JSON.stringify(entry);
    if (this.entries.some((existing) => JSON.stringify(existing) === encoded)) return;
    this.total++;
    if (Buffer.byteLength(encoded) > MAX_SEARCH_DIAGNOSTIC_BYTES) return;
    const combined = [...this.entries, entry];
    // Keep the opening diagnostics and latest failure. Omit only complete entries.
    while (
      Buffer.byteLength(JSON.stringify(combined)) > MAX_SEARCH_DIAGNOSTIC_BYTES &&
      combined.length > 1
    )
      combined.splice(combined.length - 2, 1);
    this.entries = combined;
  }

  append(snapshot: SearchDiagnostics): void {
    for (const entry of snapshot.entries) this.push(entry);
    this.total += snapshot.omittedEntries;
  }

  snapshot(): SearchDiagnostics {
    return {
      entries: [...this.entries],
      omittedEntries: this.total - this.entries.length,
      maxBytes: MAX_SEARCH_DIAGNOSTIC_BYTES,
    };
  }
}
