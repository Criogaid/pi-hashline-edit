import { Type, type Static } from "typebox";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { Text } from "@earendil-works/pi-tui";
import {
  createWriteToolDefinition,
  type Theme,
  type ToolRenderResultOptions,
} from "@earendil-works/pi-coding-agent";
import { commitFile } from "./file-commit.ts";
import { mutationToolBase, type MutationToolEnvironment } from "./mutation-runner.ts";
import { throwIfCancelled } from "./error-text.ts";
import { unwritableTextError } from "../core/text.ts";
import { MUTATION_CARD_SHOWN, reportLines, renderToolError, splitReport } from "./render.ts";
import type { MutationOutcome } from "./mutation-result.ts";
import type { ReportDetails } from "./report.ts";

const writeSchema = Type.Object(
  {
    path: Type.String({ minLength: 1, description: "Path to the file (relative or absolute)" }),
    content: Type.String({
      description: "Complete file content, written exactly as supplied, including line endings.",
    }),
    mode: Type.Union([
      Type.Literal("create", { description: "Fail if the target already exists." }),
      Type.Literal("overwrite", { description: "Fail if the target does not exist." }),
    ]),
  },
  { additionalProperties: false },
);

type WriteParams = Static<typeof writeSchema>;
/** write shows the built-in card; its report states every fact. */
type WriteMutationDetails = object;
/** The write card's call line shows the content. */
const WRITE_CARD_SHOWN = new Set([...MUTATION_CARD_SHOWN, "publication"]);
type WriteRenderContext = Parameters<
  NonNullable<ReturnType<typeof createWriteToolDefinition>["renderCall"]>
>[2];

export function makeWriteOverride(env: MutationToolEnvironment) {
  const builtin = createWriteToolDefinition(env.cwd);
  return {
    ...mutationToolBase({
      ...env,
      tool: "write",
      schema: writeSchema,
      description:
        "Write a whole file exactly as supplied, including its line endings. Do not use write for partial changes to an existing file; use edit or replace. Choose create for a new file or overwrite for an existing file. Creates missing parent directories.",
      promptSnippet: "Write complete file content to a path",
      check: (args, report) => {
        const content = (args as { content?: unknown } | null)?.content;
        const unwritable = typeof content === "string" ? unwritableTextError(content) : undefined;
        if (unwritable) report("content", unwritable.message);
      },
      async run(
        params,
        { absolutePath, signal },
      ): Promise<MutationOutcome<WriteMutationDetails, "write">> {
        throwIfCancelled(signal);
        const commit = await commitFile(absolutePath, params.content, {
          mode: params.mode,
          signal,
        });
        return {
          commit,
          details: {},
          facts: {},
        };
      },
    }),
    renderCall(args: WriteParams, theme: Theme, context: WriteRenderContext) {
      return builtin.renderCall!(args, theme, context);
    },
    renderResult(
      result: AgentToolResult<(Partial<WriteMutationDetails> & Partial<ReportDetails>) | undefined>,
      options: ToolRenderResultOptions,
      theme: Theme,
      context: WriteRenderContext,
    ) {
      if (context.isError) return renderToolError(result, "write", theme, options.expanded);
      const { report } = splitReport(result, "write");
      const facts = report ? reportLines(report, theme, WRITE_CARD_SHOWN) : [];
      if (facts.length) return new Text(facts.join("\n"), 0, 0);
      return builtin.renderResult!({ ...result, details: undefined }, options, theme, context);
    },
  };
}
