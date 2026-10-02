/**
 * Bounded diagnostic text shared by ripgrep stderr, batch aggregation, and
 * model-facing search warnings. Retain the opening context and final cause;
 * mark omitted text instead of silently dropping diagnostics.
 */
import { truncateHead, truncateTail } from "@earendil-works/pi-coding-agent";
import { formatKiB } from "./budgets.ts";

export class DiagnosticBuffer {
  private head = "";
  private tail = "";
  private truncated = false;
  private readonly notice: string;
  private readonly headBytes: number;
  private readonly tailBytes: number;

  private readonly maxBytes: number;

  constructor(maxBytes: number) {
    this.maxBytes = maxBytes;
    this.notice = `\n[Diagnostics truncated (${formatKiB(maxBytes)} limit); middle omitted.]\n`;
    const contentBytes = maxBytes - Buffer.byteLength(this.notice);
    this.headBytes = Math.floor(contentBytes / 2);
    this.tailBytes = contentBytes - this.headBytes;
  }

  append(text: string): void {
    if (!this.truncated) {
      const combined = this.head + text;
      if (Buffer.byteLength(combined) <= this.maxBytes) {
        this.head = combined;
        return;
      }
      this.head = truncateHead(combined, {
        maxBytes: this.headBytes,
        maxLines: Number.MAX_SAFE_INTEGER,
      }).content;
      this.tail = this.truncateTail(combined);
      this.truncated = true;
      return;
    }
    this.tail = this.truncateTail(this.tail + text);
  }

  toString(): string {
    return this.truncated ? this.head + this.notice + this.tail : this.head;
  }

  private truncateTail(text: string): string {
    // Pi's truncated previews omit the final newline; streaming must retain it
    // so the next chunk cannot merge two diagnostic lines.
    const newline = text.endsWith("\n") ? "\n" : "";
    const preview = truncateTail(text, {
      maxBytes: this.tailBytes - newline.length,
      maxLines: Number.MAX_SAFE_INTEGER,
    });
    return preview.content + (preview.truncated ? newline : "");
  }
}
