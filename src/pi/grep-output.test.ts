import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createAnchorFormatter, parseHashline } from "./anchor-format.ts";
import { outputBudgetsFor } from "./budgets.ts";
import { byteRevision } from "./file-revision.ts";
import { grepOutput } from "./grep-output.ts";

test("narrow grep preview centred on a low surrogate → keeps the whole matched character", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "hl-grep-preview-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));

  const name = "a.txt";
  const filePath = join(cwd, name);
  const character = "😀";
  const line = character + "abc".repeat(200);
  const bytes = Buffer.from(line);
  await writeFile(filePath, bytes);

  const anchors = createAnchorFormatter(4);
  const defaultBudget = outputBudgetsFor(undefined);
  const grepBytes = Buffer.byteLength(
    `${name} · 1 match\n${anchors.row(1, line, `[partial, columns 1-2] ${character}…`)}`,
  );
  const { payload } = await grepOutput({
    cwd,
    anchors,
    outputMode: "content",
    context: 0,
    budget: { ...defaultBudget, grepBytes },
    search: {
      files: [
        {
          filePath,
          rows: [{ lineNumber: 1, column: 1 }],
          snapshot: { revision: byteRevision(bytes), validUtf8: true },
        },
      ],
      matchLimitReached: false,
      scanLimitReached: false,
    },
    warnings: [],
    missing: [],
    effectiveLimit: 10,
    literalPipe: false,
  });

  assert.ok(payload);
  assert.match(parseHashline(payload.split("\n")[1])?.content ?? "", /😀/);
});
