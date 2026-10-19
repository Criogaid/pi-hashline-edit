import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { byteRevision } from "./file-revision.ts";
import type { MutationOutcome } from "./mutation-result.ts";

/** Build a completed overwrite fixture with matching published and observed bytes. */
export function publishedMutation<T extends object | undefined>(
  content: string,
  result: AgentToolResult<T>,
): MutationOutcome<T extends object ? T : object> {
  const revision = byteRevision(Buffer.from(content));
  return {
    details: (result.details ?? {}) as T extends object ? T : object,
    facts: {},
    commit: {
      publication: "PUBLISHED",
      baseRevision: byteRevision(Buffer.from("before\n")),
      publishedRevision: revision,
      observedRevision: revision,
      created: false,
    },
  };
}
