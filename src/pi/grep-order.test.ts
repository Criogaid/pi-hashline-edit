import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import { basename, join } from "node:path";
import { test } from "node:test";
import { setImmediate } from "node:timers/promises";
import { Worker } from "node:worker_threads";
import { computeLineHash } from "../core/hash.ts";
import { searchText, type LineSearchInput, type SearchInput } from "../core/search.ts";
import { DEFAULT_CONFIG } from "./config.ts";
import { reportOf } from "./report.ts";
import type { GrepBackend } from "./rg-process.ts";
import type { WorkerError } from "./report-cause.ts";
import { callTool } from "./tool-call.testing.ts";

test("out-of-order file completions → listing order fixes rows, warnings, and the limit cutoff", {
  timeout: 15_000,
}, async (t) => {
  const concurrentFiles = 4;
  // Fix the pool size before its module loads, including on single-core CI hosts.
  t.mock.method(os, "availableParallelism", () => concurrentFiles + 1);
  syncBuiltinESMExports();
  const { makeGrepOverrideWithBackend } = await import("./grep-tool.ts");
  t.mock.restoreAll();
  syncBuiltinESMExports();

  const dir = await fs.mkdtemp(join(os.tmpdir(), "hl-grep-order-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const names = ["00-warning.txt", "01-slow.txt", "02-fast.txt", "03-warning.txt"];
  const sourceLines = (name: string) => [`needle ${name} first`, `needle ${name} second`];
  for (const name of names.filter((name) => !name.includes("warning"))) {
    await fs.writeFile(join(dir, name), `${sourceLines(name).join("\n")}\n`);
  }
  const listingDiagnostic = "listing: Permission denied";
  const warning = (name: string) => `Could not read ${join(dir, name)}: EACCES: ${name}`;

  for (const limit of [3, 5]) {
    const outputs: unknown[] = [];
    for (const order of [
      ["02-fast.txt", "03-warning.txt", "00-warning.txt", "01-slow.txt"],
      ["00-warning.txt", "01-slow.txt", "02-fast.txt", "03-warning.txt"],
    ]) {
      await t.test(`limit=${limit}, completion=${order.join(",")}`, async (t) => {
        const ready = Promise.withResolvers<void>();
        const pending = new Map<string, () => void>();
        const hold = (name: string, finish: () => void) => {
          pending.set(name, () => {
            pending.delete(name);
            finish();
          });
          if (pending.size === concurrentFiles) ready.resolve();
        };
        const open = fs.open;
        t.mock.method(fs, "open", (...args: Parameters<typeof fs.open>) => {
          const path = args[0];
          if (
            typeof path === "string" &&
            names.some((name) => name.includes("warning") && path === join(dir, name))
          ) {
            const name = basename(path);
            return new Promise<Awaited<ReturnType<typeof fs.open>>>((_resolve, reject) => {
              hold(name, () =>
                reject(Object.assign(new Error(`EACCES: ${name}`), { code: "EACCES" })),
              );
            });
          }
          return open(...args);
        });
        syncBuiltinESMExports();
        t.mock.method(
          Worker.prototype,
          "postMessage",
          function (this: Worker, input: SearchInput | LineSearchInput) {
            assert.ok("source" in input);
            const name = input.source.includes("01-slow.txt") ? "01-slow.txt" : "02-fast.txt";
            hold(name, () => this.emit("message", { result: searchText(input) }));
          },
        );
        const backend: GrepBackend = {
          runRgPaths: async () => assert.fail("This query uses line candidates"),
          runRgLines: async (_rg, _args, _signal, _maxLines, onFile) => {
            for (const name of names) {
              if (!(await onFile(join(dir, name), undefined))) {
                return { code: 2, stderr: listingDiagnostic, stopped: true };
              }
            }
            return { code: 2, stderr: listingDiagnostic, stopped: false };
          },
        };
        const running = callTool(makeGrepOverrideWithBackend(dir, DEFAULT_CONFIG, backend), {
          path: dir,
          pattern: "needle",
          literal: true,
          limit,
        });
        try {
          await Promise.race([
            ready.promise,
            running.then(() => assert.fail("Search finished before all files were held")),
          ]);
          for (const name of order) {
            const finish = pending.get(name);
            assert.ok(finish, `Missing completion for ${name}`);
            finish();
            await setImmediate();
          }
          const result = await running;
          assert.equal(result.isError, undefined, JSON.stringify(reportOf(result, "grep")));
          const payload = result.content[0];
          assert.ok(payload.type === "text");
          const expected = ["01-slow.txt", "02-fast.txt"]
            .map((name, index) => {
              const lines = sourceLines(name).slice(0, index === 0 || limit === 5 ? 2 : 1);
              return [
                `${name} · ${lines.length} match${lines.length === 1 ? "" : "es"}`,
                ...lines.map(
                  (line, index) =>
                    `${index + 1}#${computeLineHash(index + 1, line, DEFAULT_CONFIG.hashLen)}│${line}`,
                ),
              ].join("\n");
            })
            .join("\n\n");
          assert.equal(payload.text, expected);
          const report = reportOf(result, "grep");
          assert.ok(report);
          assert.equal(report.matches, limit === 3 ? 3 : 4);
          assert.equal(report.files, 2);
          assert.equal(report.matchLimit, limit === 3 ? limit : undefined);
          assert.equal(
            report.diagnostics,
            [
              warning("00-warning.txt"),
              ...(limit === 5 ? [warning("03-warning.txt")] : []),
              listingDiagnostic,
            ].join("\n"),
          );
          outputs.push(result.content);
        } finally {
          for (const finish of [...pending.values()]) finish();
          await running;
          t.mock.restoreAll();
          syncBuiltinESMExports();
        }
      });
    }
    assert.deepEqual(outputs[0], outputs[1]);
  }
});

test("file-associated failure → listing position decides failure or cutoff, while cancellation stays immediate", {
  timeout: 15_000,
}, async (t) => {
  t.mock.method(os, "availableParallelism", () => 3);
  syncBuiltinESMExports();
  const { makeGrepOverrideWithBackend } = await import("./grep-tool.ts");
  t.mock.restoreAll();
  syncBuiltinESMExports();
  const dir = await fs.mkdtemp(join(os.tmpdir(), "hl-grep-failure-order-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const names = ["a.txt", "z.txt"];
  for (const name of names) await fs.writeFile(join(dir, name), `needle ${name}\n`);
  const timeout: WorkerError = {
    code: "REGEX_TIMEOUT",
    message: "Regex evaluation timed out.",
    facts: { timeoutMs: DEFAULT_CONFIG.grep.regexTimeoutMs },
  };
  const failures = [
    {
      name: "timeout",
      code: timeout.code,
      finish: (worker: Worker) => worker.emit("message", { error: timeout }),
    },
    {
      name: "worker error",
      code: "REGEX_WORKER_FAILED",
      finish: (worker: Worker) => worker.emit("error", new Error("Worker crashed")),
    },
    {
      name: "inconsistent rows",
      code: "REGEX_WORKER_FAILED",
      finish: (worker: Worker) =>
        worker.emit("message", {
          result: { totalLines: 2, lines: [{ lineNumber: 1, column: 0 }] },
        }),
    },
  ] as const;
  const backend: GrepBackend = {
    runRgPaths: async () => assert.fail("This query uses line candidates"),
    runRgLines: async (_rg, _args, _signal, _maxLines, onFile) => {
      for (const name of names) if (!(await onFile(join(dir, name), undefined))) break;
      return { code: 0, stderr: "", stopped: false };
    },
  };
  for (const failure of failures) {
    for (const outcome of ["limited", "failed", "cancelled"] as const) {
      const outputs: unknown[] = [];
      for (const failureFirst of outcome === "cancelled" ? [true] : [false, true]) {
        await t.test(
          JSON.stringify({ failure: failure.name, outcome, failureFirst }),
          async (t) => {
            const ready = Promise.withResolvers<void>();
            const pending = new Map<
              string,
              {
                worker: Worker;
                input: SearchInput;
                stopped: ReturnType<typeof Promise.withResolvers<void>>;
              }
            >();
            const terminate = Worker.prototype.terminate;
            t.mock.method(Worker.prototype, "terminate", function (this: Worker) {
              for (const file of pending.values()) if (file.worker === this) file.stopped.resolve();
              return terminate.call(this);
            });
            t.mock.method(
              Worker.prototype,
              "postMessage",
              function (this: Worker, input: SearchInput | LineSearchInput) {
                assert.ok("source" in input);
                const name = input.source.includes("a.txt") ? "a.txt" : "z.txt";
                pending.set(name, { worker: this, input, stopped: Promise.withResolvers<void>() });
                if (pending.size === names.length) ready.resolve();
              },
            );
            const controller = new AbortController();
            const running = callTool(
              makeGrepOverrideWithBackend(dir, DEFAULT_CONFIG, backend),
              {
                path: dir,
                pattern: "needle",
                literal: true,
                limit: outcome === "failed" ? 2 : 1,
              },
              { signal: controller.signal },
            );
            try {
              await Promise.race([
                ready.promise,
                running.then(() => assert.fail("Search finished before both workers were held")),
              ]);
              const early = pending.get("a.txt");
              const late = pending.get("z.txt");
              assert.ok(early && late);
              const succeed = () =>
                early.worker.emit("message", { result: searchText(early.input) });
              if (failureFirst) failure.finish(late.worker);
              else succeed();
              await (failureFirst ? late : early).stopped.promise;
              if (outcome === "cancelled") controller.abort();
              else if (failureFirst) succeed();
              else failure.finish(late.worker);
              const result = await running;
              const report = reportOf(result, "grep");
              if (outcome === "limited") {
                assert.equal(result.isError, undefined, JSON.stringify(report));
                assert.equal(report?.matchLimit, 1);
                assert.equal(report?.diagnostics, undefined);
                assert.match(result.content[0].text, /1#[0-9A-Z]+│needle a\.txt/);
              } else {
                assert.equal(result.isError, true);
                assert.equal(
                  report?.error,
                  outcome === "cancelled" ? "OPERATION_ABORTED" : failure.code,
                );
              }
              outputs.push(result.content);
            } finally {
              controller.abort();
              await running;
            }
          },
        );
      }
      if (outputs.length === 2) assert.deepEqual(outputs[0], outputs[1]);
    }
  }
});
