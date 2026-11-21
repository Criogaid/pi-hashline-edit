/**
 * Bounded diagnostic text shared by ripgrep stderr, report causes, and
 * model-facing search warnings. Retain the opening context and final cause;
 * mark omitted text instead of silently dropping diagnostics.
 */
import { formatByteSize } from "./budgets.ts";

/** A cut inside a UTF-8 character moves inward, toward the bytes being kept. */
function utf8Boundary(bytes: Buffer, boundary: number, step: -1 | 1): number {
  while (boundary < bytes.length && (bytes[boundary] & 0xc0) === 0x80) boundary += step;
  return boundary;
}

export class DiagnosticBuffer {
  private head = "";
  private tail = "";
  private truncated = false;
  private readonly maxBytes: number;
  private readonly notice: string;
  private readonly headBytes: number;
  private readonly tailBytes: number;

  constructor(maxBytes: number) {
    this.maxBytes = maxBytes;
    this.notice = `\n[Diagnostics truncated (${formatByteSize(maxBytes)} limit); middle omitted.]\n`;
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
      const bytes = Buffer.from(combined);
      const end = utf8Boundary(bytes, Math.min(bytes.length, this.headBytes), -1);
      this.head = bytes.subarray(0, end).toString("utf8");
      this.tail = this.truncateTail(bytes);
      this.truncated = true;
      return;
    }
    this.tail = this.truncateTail(Buffer.from(this.tail + text));
  }

  toString(): string {
    return this.truncated ? this.head + this.notice + this.tail : this.head;
  }

  private truncateTail(bytes: Buffer): string {
    const start = utf8Boundary(bytes, Math.max(0, bytes.length - this.tailBytes), 1);
    return bytes.subarray(start).toString("utf8");
  }
}
