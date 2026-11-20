/** Regenerate the pairwise fixture: node src/testing/generate-pict-matrix.ts <path-to-PICT>. */
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PICT_FIXTURE, pictModel } from "../core/pict-matrix.testing.ts";

const executable = process.argv[2];
if (!executable) throw new Error("Pass the path to the PICT executable.");
const workspace = mkdtempSync(join(tmpdir(), "hl-pict-model-"));
try {
  const model = join(workspace, "grep.txt");
  writeFileSync(model, `${pictModel()}\n`);
  const rows = execFileSync(executable, [model, "/o:2"], { encoding: "utf8", timeout: 10_000 });
  writeFileSync(PICT_FIXTURE, `${rows.trimEnd().replaceAll("\r\n", "\n")}\n`);
} finally {
  rmSync(workspace, { force: true, recursive: true });
}
