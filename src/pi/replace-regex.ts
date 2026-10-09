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
import { errorMessage, HashlineError, type ErrorCode } from "../core/errors.ts";
import { cancellationError, throwIfCancelled } from "./error-text.ts";

type ReplaceResult = ReturnType<typeof applyReplacements>;
type WorkerMessage = {
  result?: ReplaceResult;
  error?: { readonly code: ErrorCode; readonly message: string };
};

function workerFailure(message: string, cause?: unknown): HashlineError {
  return new HashlineError("REGEX_WORKER_FAILED", message, { cause });
}

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
          new HashlineError("REGEX_TIMEOUT", `Regex evaluation timed out after ${timeoutMs} ms.`),
          true,
        ),
      timeoutMs,
    );
    worker.on("message", (message: WorkerMessage) => {
      if (message.error !== undefined)
        finish(new HashlineError(message.error.code, message.error.message));
      else if (message.result) finish(message.result);
      else finish(workerFailure("Regex worker returned an invalid result."));
    });
    worker.on("error", (error) => finish(workerFailure(errorMessage(error), error)));
    worker.on("exit", (code) => finish(workerFailure(`Regex worker exited with code ${code}.`)));
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
  });
}
