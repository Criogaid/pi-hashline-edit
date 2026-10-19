/**
 * A file revision is the SHA-256 hex digest of its exact bytes, computed whole or streamed;
 * equal bytes always give equal revisions. Commits and streaming scans share this one rule.
 *
 * @module pi-hashline-edit/pi
 */
import { createHash } from "node:crypto";

export function createRevisionHasher() {
  const hash = createHash("sha256");
  return {
    update(bytes: Uint8Array): void {
      hash.update(bytes);
    },
    digest(): string {
      return hash.digest("hex");
    },
  };
}

export function byteRevision(bytes: Uint8Array): string {
  const hasher = createRevisionHasher();
  hasher.update(bytes);
  return hasher.digest();
}
