import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { byteRevision } from "./file-commit.ts";
import type { MutationOutcome } from "./mutation-result.ts";

/** Build a completed overwrite fixture with matching published and observed bytes. */
export function publishedMutation<T>(
  content: string,
  result: AgentToolResult<T>,
  anchors?: string,
): MutationOutcome<T> {
  const revision = byteRevision(content);
  return {
    result,
    commit: {
      publication: "PUBLISHED",
      publishedRevision: revision,
      observedRevision: revision,
      created: false,
    },
    anchors,
  };
}
