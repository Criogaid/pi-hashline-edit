/**
 * Bounded diagnostic text shared by ripgrep stderr, batch aggregation, and
 * model-facing search warnings. Retain the opening context and final cause;
 * mark omitted text instead of silently dropping diagnostics.
 */
import { formatKiB } from "./budgets.ts";

/** Cut only at UTF-8 boundaries; diagnostics may contain a single oversized line. */
function byteSlice(text: string, maxBytes: number, tail: boolean): string {
  const bytes = Buffer.from(text);
  let boundary = tail ? Math.max(0, bytes.length - maxBytes) : Math.min(bytes.length, maxBytes);
  while (boundary < bytes.length && (bytes[boundary] & 0xc0) === 0x80) boundary += tail ? 1 : -1;
  return (tail ? bytes.subarray(boundary) : bytes.subarray(0, boundary)).toString("utf8");
}

export class DiagnosticBuffer {
  private head = "";
  private tail = "";
  private truncated = false;
  private inputBytes = 0;
  get omittedBytes(): number {
    return this.inputBytes - Buffer.byteLength(this.head) - Buffer.byteLength(this.tail);
  }
  private readonly notice: string;
  private readonly headBytes: number;
  private readonly tailBytes: number;

  private readonly maxBytes: number;

  constructor(maxBytes: number) {
    this.maxBytes = maxBytes;
    const notice = `\n[Diagnostics truncated (${formatKiB(maxBytes)} limit); middle omitted.]\n`;
    this.notice = Buffer.byteLength(notice) <= maxBytes ? notice : "";
    const contentBytes = maxBytes - Buffer.byteLength(this.notice);
    this.headBytes = Math.floor(contentBytes / 2);
    this.tailBytes = contentBytes - this.headBytes;
  }

  append(text: string): void {
    this.inputBytes += Buffer.byteLength(text);
    if (!this.truncated) {
      const combined = this.head + text;
      if (Buffer.byteLength(combined) <= this.maxBytes) {
        this.head = combined;
        return;
      }
      this.head = byteSlice(combined, this.headBytes, false);
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
    return byteSlice(text, this.tailBytes, true);
  }
}
