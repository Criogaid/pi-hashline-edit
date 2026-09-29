/**
 * End-to-End file editing workflow tests for pi-hashline-edit.
 * Evaluates the full pipeline:
 * Discovery -> Search/Read -> Anchor Localization -> Edit Construction -> Apply -> Recovery -> Verification.
 *
 * Covers Dev Set (D1-D6) and Holdout Set (H1-H3).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeEditOverride } from "./edit-tool.ts";
import { makeReadOverride } from "./read-tool.ts";
import { makeGrepOverride } from "./grep-tool.ts";
import { makeReplaceTool } from "./replace-tool.ts";
import { createActionFusionExecutor } from "./action-fusion.ts";
import { computeLineHash } from "../core/hash.ts";
import { splitLines } from "../core/lines.ts";
import { callTool } from "./tool-call.testing.ts";

async function withDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "hl-e2e-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const call = (tool: any, params: any) => callTool(tool, params, { toolCallId: "0" });

function h(text: string, line: number) {
  return `${line}#${computeLineHash(line, splitLines(text)[line - 1])}`;
}

function anchorLine(block: string, line: number) {
  const m = new RegExp(`^${line}#([0-9A-Z]+)(?:│|$)`, "m").exec(block);
  if (!m) throw new Error(`line ${line} anchor not found in block:\n${block}`);
  return `${line}#${m[1]}`;
}

// ---------------------------------------------------------------------------
// Dev Set (D1 - D6)
// ---------------------------------------------------------------------------

test("E2E Dev D1: Search-and-edit single function without separate read call", async () =>
  withDir(async (dir) => {
    const file = join(dir, "calc.ts");
    const original =
      [
        "import { math } from './math.ts';",
        "",
        "export function calculateDiscount(price: number): number {",
        "  if (price <= 0) return 0;",
        "  return price * 0.1;",
        "}",
        "",
        "export function formatCurrency(amount: number): string {",
        "  return `$${amount.toFixed(2)}`;",
        "}",
      ].join("\n") + "\n";
    await writeFile(file, original);

    const grep = makeGrepOverride(dir);
    const edit = makeEditOverride(dir);

    // Turn 1: Search with context: 3
    const grepResult = await call(grep, {
      path: "calc.ts",
      pattern: "calculateDiscount",
      context: 3,
    });
    const grepText = grepResult.content[0].text;
    assert.ok(grepText.includes("calculateDiscount"));

    // Extract anchors directly from grep result
    const targetAnchor = anchorLine(grepText, 5); // "  return price * 0.1;"

    // Turn 2: Direct edit using grep-provided anchor, without calling read!
    const editResult = await call(edit, {
      path: "calc.ts",
      edits: [{ op: "replace", anchor: targetAnchor, body: ["  return price * 0.15;"] }],
    });
    assert.equal(editResult.isError, undefined);

    // Verify target file state
    const updated = await readFile(file, "utf8");
    assert.ok(updated.includes("return price * 0.15;"));
    assert.ok(updated.includes("export function formatCurrency")); // outside range untouched
  }));

test("E2E Dev D2: Chained multi-site edits using returned fresh anchors", async () =>
  withDir(async (dir) => {
    const file = join(dir, "service.ts");
    const original =
      [
        "class Service {",
        "  version = 1;",
        "  enabled = false;",
        "  status() {",
        "    return 'idle';",
        "  }",
        "}",
      ].join("\n") + "\n";
    await writeFile(file, original);

    const edit = makeEditOverride(dir);

    // Step 1: Edit version
    const r1 = await call(edit, {
      path: "service.ts",
      edits: [{ op: "replace", anchor: h(original, 2), body: ["  version = 2;"] }],
    });
    const returnedAnchor = anchorLine(r1.content[0].text, 2);
    assert.equal(returnedAnchor, h("class Service {\n  version = 2;\n", 2));

    // Step 2: Reuse the returned anchor and edit another site in the same batch.
    const r2 = await call(edit, {
      path: "service.ts",
      edits: [
        { op: "replace", anchor: returnedAnchor, body: ["  version = 3;"] },
        { op: "replace", anchor: h(original, 5), body: ["    return 'active';"] },
      ],
    });
    assert.match(r2.content[0].text, /Updated anchors:/);

    const final = await readFile(file, "utf8");
    assert.equal(
      final,
      [
        "class Service {",
        "  version = 3;",
        "  enabled = false;",
        "  status() {",
        "    return 'active';",
        "  }",
        "}",
      ].join("\n") + "\n",
    );
  }));

test("E2E Dev D3: Recovery from shifted anchor after external line insertion", async () =>
  withDir(async (dir) => {
    const file = join(dir, "config.ts");
    const original =
      [
        "// Config file",
        "export const TIMEOUT = 1000;",
        "export const RETRIES = 3;",
        "export const DEBUG = false;",
      ].join("\n") + "\n";
    await writeFile(file, original);

    // Agent observed anchor at line 3 ("export const RETRIES = 3;")
    const staleAnchor = h(original, 3);

    // External process inserts 2 lines at top
    const externallyModified =
      [
        "// Header comment line 1",
        "// Header comment line 2",
        "// Config file",
        "export const TIMEOUT = 1000;",
        "export const RETRIES = 3;",
        "export const DEBUG = false;",
      ].join("\n") + "\n";
    await writeFile(file, externallyModified);

    const edit = makeEditOverride(dir);

    // Agent attempts edit with stale anchor
    let candidateAnchor = "";
    await assert.rejects(
      call(edit, {
        path: "config.ts",
        edits: [{ op: "replace", anchor: staleAnchor, body: ["export const RETRIES = 5;"] }],
      }),
      (error: Error) => {
        assert.match(error.message, /Anchor mismatch: 1 shifted/);
        assert.match(error.message, /candidate 5#/); // Shifted to line 5
        const match = /candidate ([0-9]+#[0-9A-Z]+)/.exec(error.message);
        if (match) candidateAnchor = match[1];
        return true;
      },
    );

    assert.ok(candidateAnchor.length > 0, "Recovery candidate was found and returned");

    // Agent retries using candidate anchor
    const recovered = await call(edit, {
      path: "config.ts",
      edits: [{ op: "replace", anchor: candidateAnchor, body: ["export const RETRIES = 5;"] }],
    });
    assert.equal(recovered.isError, undefined);

    const resultText = await readFile(file, "utf8");
    assert.ok(resultText.includes("export const RETRIES = 5;"));
    assert.ok(resultText.includes("// Header comment line 1"));
  }));

test("E2E Dev D4: Bulk replace with Action Fusion then_run validation", async () =>
  withDir(async (dir) => {
    const file = join(dir, "api.ts");
    await writeFile(file, "const old_var_1 = 10;\nconst old_var_2 = 20;\n");

    let commandRan = false;
    const fusionExecutor = createActionFusionExecutor(async (_id, input) => {
      commandRan = true;
      assert.equal(input.command, "npm run check");
      return "All checks passed";
    });

    const replace = makeReplaceTool(dir, fusionExecutor);
    const res = await call(replace, {
      path: "api.ts",
      replacements: [{ find: "old_var", replace: "new_var" }],
      then_run: { command: "npm run check" },
    });

    assert.equal(commandRan, true);
    assert.equal(res.details.actionFusion.command, "succeeded");
    assert.equal(res.details.actionFusion.freshness, "unchanged");
    assert.match(res.content[1].text, /All checks passed/);

    const content = await readFile(file, "utf8");
    assert.equal(content, "const new_var_1 = 10;\nconst new_var_2 = 20;\n");
  }));

test("E2E Dev D5: Line ending preservation and deletion successor anchor", async () =>
  withDir(async (dir) => {
    const file = join(dir, "crlf.txt");
    // CRLF file
    const crlfText = "line1\r\nline2\r\nline3\r\nline4\r\n";
    await writeFile(file, crlfText);

    const edit = makeEditOverride(dir);

    // Delete line 2: line 3 shifts to line 2 (deletion successor)
    const res = await call(edit, {
      path: "crlf.txt",
      edits: [{ op: "delete", anchor: h(crlfText, 2) }],
    });

    // Deletion successor anchor should be returned with full row
    assert.match(res.content[0].text, /2#[0-9A-Z]+│line3/);

    // File bytes must retain CRLF line endings
    const afterBytes = await readFile(file);
    assert.equal(afterBytes.toString("utf8"), "line1\r\nline3\r\nline4\r\n");
  }));

test("E2E Dev D6: structured edit batches use one original snapshot", async () =>
  withDir(async (dir) => {
    const file = join(dir, "batch.txt");
    const original = "alpha\nbeta\ngamma\n";
    await writeFile(file, original);
    await call(makeEditOverride(dir), {
      path: "batch.txt",
      edits: [
        { op: "replace", anchor: h(original, 1), body: ["ALPHA"] },
        { op: "replace", anchor: h(original, 3), body: ["GAMMA"] },
      ],
    });
    assert.equal(await readFile(file, "utf8"), "ALPHA\nbeta\nGAMMA\n");
  }));

// ---------------------------------------------------------------------------
// Holdout Set (H1 - H3)
// ---------------------------------------------------------------------------

test("E2E Holdout H1: Ambiguous candidates provide distinguishing neighborhoods", async () =>
  withDir(async (dir) => {
    const file = join(dir, "ambiguous.txt");
    const text =
      ["function one() {", "  return true;", "}", "function two() {", "  return true;", "}"].join(
        "\n",
      ) + "\n";
    await writeFile(file, text);

    const edit = makeEditOverride(dir);
    // The cited content moved away from line 3 and now occurs at lines 2 and 5.
    const staleAnchor = h("header\nheader\n  return true;\n", 3);
    let candidateAnchor = "";
    await assert.rejects(
      call(edit, {
        path: "ambiguous.txt",
        edits: [{ op: "replace", anchor: staleAnchor, body: ["  return false;"] }],
      }),
      (error: Error) => {
        assert.match(error.message, /ambiguous checksum matches/);
        assert.match(error.message, /Ambiguous-candidate neighborhoods/);
        assert.ok(error.message.includes(`${h(text, 2)}│  return true;`));
        assert.ok(error.message.includes(`${h(text, 5)}│  return true;`));
        assert.ok(error.message.includes(`${h(text, 1)}│function one() {`));
        assert.ok(error.message.includes(`${h(text, 4)}│function two() {`));
        candidateAnchor = anchorLine(
          error.message.split("Ambiguous-candidate neighborhoods")[1],
          5,
        );
        return true;
      },
    );
    assert.equal(await readFile(file, "utf8"), text);
    await call(edit, {
      path: "ambiguous.txt",
      edits: [{ op: "replace", anchor: candidateAnchor, body: ["  return false;"] }],
    });
    assert.equal(
      await readFile(file, "utf8"),
      "function one() {\n  return true;\n}\nfunction two() {\n  return false;\n}\n",
    );
  }));

test("E2E Holdout H2: Action Fusion command failure preserves file changes and anchors", async () =>
  withDir(async (dir) => {
    const file = join(dir, "fusion_fail.ts");
    await writeFile(file, "let x = 1;\n");

    const fusionExecutor = createActionFusionExecutor(async () => {
      throw new Error("Syntax error on line 42");
    });

    const edit = makeEditOverride(dir, fusionExecutor);
    const res = await call(edit, {
      path: "fusion_fail.ts",
      edits: [{ op: "replace", anchor: h("let x = 1;\n", 1), body: ["let x = 2;"] }],
      then_run: { command: "test" },
    });

    // File change must be published and saved
    assert.equal(await readFile(file, "utf8"), "let x = 2;\n");
    assert.equal(res.details.actionFusion.publication, "PUBLISHED");
    assert.equal(res.details.actionFusion.command, "failed");
    assert.match(res.content[0].text, /Edited fusion_fail\.ts/);
    assert.match(res.content[0].text, /Updated anchors/);
    assert.match(res.content[1].text, /Syntax error on line 42/);
  }));

test("E2E Holdout H3: UTF-8 BOM file retains BOM at byte 0 after first-line edit", async () =>
  withDir(async (dir) => {
    const file = join(dir, "bom.txt");
    const bomContent = "\uFEFFline1\nline2\n";
    await writeFile(file, bomContent);

    const edit = makeEditOverride(dir);
    const a1 = h(bomContent, 1);

    await call(edit, {
      path: "bom.txt",
      edits: [{ op: "replace", anchor: a1, body: ["replaced1"] }],
    });

    const afterBytes = await readFile(file);
    assert.equal(afterBytes[0], 0xef);
    assert.equal(afterBytes[1], 0xbb);
    assert.equal(afterBytes[2], 0xbf);
    assert.equal(afterBytes.toString("utf8"), "\uFEFFreplaced1\nline2\n");
  }));
