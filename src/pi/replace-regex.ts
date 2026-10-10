/**
 * Run a replace batch that contains regex rules in a worker thread, so a
 * catastrophic pattern can be stopped by the configured timeout or by
 * cancellation. The worker (`replace-worker.mjs` → `replace-worker.ts`) calls
 * the same `core/replace.ts` engine that literal-only batches run in-process.
 *
 * @module pi-hashline-edit/pi
 */

import { Worker } from "node:worker_threads";
import type { applyReplacements, Replacement } from "../core/replace.ts";
import { HashlineError } from "../core/errors.ts";
import { decodeWorkerReply, restoreWorkerError } from "./replace-worker-contract.ts";
import { cancellationError, throwIfCancelled } from "./error-text.ts";

type ReplaceResult = ReturnType<typeof applyReplacements>;

export async function runRegexReplacements(
  source: string,
  rules: readonly Replacement[],
  timeoutMs: number,
  signal: AbortSignal | undefined,
): Promise<ReplaceResult> {
  throwIfCancelled(signal);
  const worker = new Worker(new URL("./replace-worker.mjs", import.meta.url), {
    workerData: { source, rules },
  });
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (result: ReplaceResult | Error, terminate = false) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      const complete = () => (result instanceof Error ? reject(result) : resolve(result));
      if (terminate) void worker.terminate().then(complete, reject);
      else complete();
    };
    const abort = () => finish(cancellationError(), true);
    const timer = setTimeout(
      () =>
        finish(
          new HashlineError("REGEX_TIMEOUT", "Regex evaluation timed out.", {
            facts: { timeoutMs },
          }),
          true,
        ),
      timeoutMs,
    );
    worker.on("message", (value: unknown) => {
      const message = decodeWorkerReply(value);
      if (!message)
        finish(
          new HashlineError("REGEX_WORKER_FAILED", "Regex worker returned an invalid result."),
          true,
        );
      else if ("error" in message) finish(restoreWorkerError(message.error));
      else finish(message.result);
    });
    worker.on("error", (error) =>
      finish(new HashlineError("REGEX_WORKER_FAILED", "Regex worker failed.", { cause: error })),
    );
    worker.on("exit", (exitCode) =>
      finish(
        new HashlineError("REGEX_WORKER_FAILED", "Regex worker exited before replying.", {
          facts: { exitCode },
        }),
      ),
    );
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
  });
}
