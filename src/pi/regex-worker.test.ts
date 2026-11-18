import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

const workerModule = pathToFileURL(resolve("src/pi/regex-worker.ts")).href;
const grepEntry = pathToFileURL(resolve("src/pi/grep-worker.mjs")).href;
const replaceEntry = pathToFileURL(resolve("src/pi/replace-worker.mjs")).href;

test("input-type inherited from eval → both file workers run with other flags preserved", () => {
  const script = `
    (async () => {
    const { default: assert } = await import('node:assert/strict');
    const { withRegexWorker } = await import(${JSON.stringify(workerModule)});
    const run = (entry, input) => withRegexWorker(new URL(entry), value => value, 10000, undefined, send => send(input));
    const probe = new URL('data:text/javascript,' + encodeURIComponent("import { parentPort } from 'node:worker_threads'; parentPort.on('message', () => parentPort.postMessage({ result: process.execArgv }));"));
    const flags = await run(probe.href, {});
    assert.ok(flags.includes('--no-warnings'));
    assert.deepEqual(flags, process.execArgv);
    const search = await run(${JSON.stringify(grepEntry)}, { source: 'safe', query: { patterns: ['safe'], literal: false, ignoreCase: false, multiline: false }, limit: 10 });
    assert.equal(search.lines.length, 1);
    const replacement = await run(${JSON.stringify(replaceEntry)}, { source: 'safe', rules: [{ find: 'safe', replace: 'changed', literal: false }] });
    assert.equal(replacement.text, 'changed');
    })().catch(error => { console.error(error); process.exitCode = 1; });
  `;
  for (const flags of [
    ["--input-type=module"],
    ["--input-type", "module"],
    ["--input-type=commonjs"],
    ["--input-type", "commonjs"],
    ["--use-largepages=off"],
    ["--use-largepages=off", "--input-type=module"],
    ["--use-largepages=off", "--input-type=commonjs"],
  ]) {
    const result = spawnSync(process.execPath, [...flags, "--no-warnings", "--eval", script], {
      encoding: "utf8",
      timeout: 30000,
    });
    assert.equal(result.status, 0, `${flags.join(" ")}: ${result.stderr}`);
  }
});
