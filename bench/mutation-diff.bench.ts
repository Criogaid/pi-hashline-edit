/**
 * Paired end-to-end edit and replace latency, diff generation included.
 *
 *   node --expose-gc bench/mutation-diff.bench.ts <installed-baseline-worktree> [pairs]
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { cpus, tmpdir, version as osVersion } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Value } from "typebox/value";
import type { makeEditOverride } from "../src/pi/edit-tool.ts";
import { SCRIPT_OUTPUT_SCHEMAS } from "../src/pi/report-schema.ts";
import type { makeReplaceTool } from "../src/pi/replace-tool.ts";

type EditArgs = Parameters<ReturnType<typeof makeEditOverride>["execute"]>[1];
type ReplaceArgs = Parameters<ReturnType<typeof makeReplaceTool>["execute"]>[1];
type MutationCall = [name: "edit", args: EditArgs] | [name: "replace", args: ReplaceArgs];
type AnchorFormatter = (row: number, body: string) => string;

export async function loadTools(root: string, cwd: string, actionFusion: boolean) {
  const from = <Module>(path: string): Promise<Module> =>
    import(pathToFileURL(join(root, "src", path)).href);
  const [hash, budgets, config, mutation, fusion, edit, replace, fixture] = await Promise.all([
    from<typeof import("../src/core/hash.ts")>("core/hash.ts"),
    from<typeof import("../src/pi/budgets.ts")>("pi/budgets.ts"),
    from<typeof import("../src/pi/config.ts")>("pi/config.ts"),
    from<typeof import("../src/pi/mutation-runner.ts")>("pi/mutation-runner.ts"),
    from<typeof import("../src/pi/action-fusion.ts")>("pi/action-fusion.ts"),
    from<typeof import("../src/pi/edit-tool.ts")>("pi/edit-tool.ts"),
    from<typeof import("../src/pi/replace-tool.ts")>("pi/replace-tool.ts"),
    from<typeof import("../src/pi/tool-call.testing.ts")>("pi/tool-call.testing.ts"),
  ]);
  const settings = { ...config.loadConfig(cwd), actionFusion };
  const env = {
    cwd,
    config: settings,
    budgets: () => budgets.outputBudgetsFor(undefined),
    schedule: actionFusion ? fusion.createActionFusionScheduler(() => {}) : mutation.runAlone,
  };
  const tools = { edit: edit.makeEditOverride(env), replace: replace.makeReplaceTool(env) };
  return {
    anchor: (row: number, body: string) =>
      `${row}#${hash.computeLineHash(row, body, settings.hashLen)}`,
    call: (...[name, args]: MutationCall) => fixture.callTool(tools[name], args),
  };
}

const MiB = 2 ** 20;
const hashBytes = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
type Scenario = {
  readonly name: string;
  readonly rows: number;
  readonly eol: "\r\n" | "\n";
} & (
  | { readonly steps: number; readonly late?: true; readonly denseRange?: number }
  | { readonly rules: number; readonly stride: number }
);

type Fixture = { readonly source: string; readonly expected: string } & (
  | { readonly call: Extract<MutationCall, ["edit", EditArgs]>; readonly matches?: never }
  | { readonly call: Extract<MutationCall, ["replace", ReplaceArgs]>; readonly matches: number }
);

const cases: readonly Scenario[] = [
  { name: "edit-crlf-32m-64", rows: 330_000, eol: "\r\n", steps: 64 },
  { name: "edit-crlf-32m-late", rows: 330_000, eol: "\r\n", steps: 1, late: true },
  { name: "replace-crlf-32m-32", rows: 330_000, eol: "\r\n", rules: 32, stride: 512 },
  { name: "edit-crlf-5m-64-range", rows: 52_000, eol: "\r\n", steps: 64, denseRange: 192 },
  { name: "edit-lf-32m-64", rows: 330_000, eol: "\n", steps: 64 },
  { name: "edit-crlf-50k-64", rows: 540, eol: "\r\n", steps: 64 },
  { name: "edit-lf-50k-64", rows: 540, eol: "\n", steps: 64 },
];

function makeFixture(spec: Scenario, path: string, anchor: AnchorFormatter): Fixture {
  const { rows, eol } = spec;
  const lines = Array.from({ length: rows }, (_, i) => {
    const marker =
      "rules" in spec && i % spec.stride === 0
        ? `legacy_key_${String((i / spec.stride) % spec.rules).padStart(2, "0")}`
        : "active_key_00";
    return `record=${String(i + 1).padStart(6, "0")} ${marker} mode=enabled source=generated label=production-profile level=info`;
  });
  if (eol === "\r\n") lines[0] = `\uFEFF${lines[0]}`;
  const source = lines.join(eol) + eol;
  if ("rules" in spec) {
    const { rules, stride } = spec;
    const replacements: ReplaceArgs["replacements"] = Array.from({ length: rules }, (_, i) => {
      const find = `legacy_key_${String(i).padStart(2, "0")}`;
      return { literal: true, find, replace: find.replace("legacy_", "current_") };
    });
    const expected = source.replaceAll("legacy_", "current_");
    return {
      source,
      expected,
      call: ["replace", { path, replacements }],
      matches: Math.ceil(rows / stride),
    };
  }
  const expectedRows = [...lines];
  const { steps, late, denseRange } = spec;
  const edits: EditArgs["steps"] = Array.from({ length: steps }, (_, i) => {
    const start = late ? rows - 1 : Math.floor(((i + 1) * rows) / (steps + 1));
    const count = i === 0 && denseRange ? denseRange : 1;
    const end = start + count - 1;
    const body = lines
      .slice(start, end + 1)
      .map((line) => line.replace("mode=enabled", "mode=disabled"));
    expectedRows.splice(start, count, ...body);
    return {
      action: "replace",
      anchor: anchor(start + 1, lines[start]),
      ...(count > 1 ? { end: anchor(end + 1, lines[end]) } : {}),
      lines: body,
    };
  });
  return { source, expected: expectedRows.join(eol) + eol, call: ["edit", { path, steps: edits }] };
}

async function main() {
  const [, , baseline, reps = "9"] = process.argv;
  assert.ok(baseline && Number.isInteger(Number(reps)) && Number(reps) >= 5);
  assert.ok(global.gc, "Run with --expose-gc");
  const dir = await mkdtemp(join(tmpdir(), "hashline-mutation-diff-"));
  try {
    const path = join(dir, "records.txt");
    const base = await loadTools(resolve(baseline), dir, false);
    const head = await loadTools(resolve(import.meta.dirname, ".."), dir, false);
    const implementations = { base, head };
    console.log(
      JSON.stringify({
        node: process.version,
        os: osVersion(),
        cpu: cpus()[0].model,
        pairs: Number(reps),
        fixtureDirectory: dir,
      }),
    );
    for (const spec of cases) {
      const item = makeFixture(spec, path, base.anchor);
      const expected = hashBytes(item.expected);
      for (let rep = -2; rep < Number(reps); rep++) {
        const baseFirst = rep % 2 === 0;
        const order = baseFirst ? (["base", "head"] as const) : (["head", "base"] as const);
        const results: Partial<Record<keyof typeof implementations, string>> = {};
        const ms: Partial<Record<keyof typeof implementations, number>> = {};
        for (const name of order) {
          const implementation = implementations[name];
          await writeFile(path, item.source);
          global.gc();
          const begin = performance.now();
          const result = await implementation.call(...item.call);
          ms[name] = performance.now() - begin;
          const { structuredContent, details } = result;
          assert.ok(Value.Check(SCRIPT_OUTPUT_SCHEMAS[item.call[0]], structuredContent));
          assert.equal(structuredContent.publication, "PUBLISHED");
          if (item.call[0] === "replace") {
            assert.ok("matches" in structuredContent);
            assert.equal(structuredContent.matches, item.matches);
          }
          assert.ok("diff" in details && details.diff);
          assert.equal(hashBytes(await readFile(path)), expected);
          results[name] = JSON.stringify(result);
        }
        assert.equal(results.base, results.head, spec.name);
        console.log(
          JSON.stringify({
            case: spec.name,
            mib: Buffer.byteLength(item.source) / MiB,
            rep,
            warmup: rep < 0,
            baseFirst,
            ...ms,
          }),
        );
      }
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

if (import.meta.main) await main();
