/** Own one regex worker's timeout, cancellation, and cleanup; callers await each request. */
import { Worker, type ResourceLimits } from "node:worker_threads";
import { HashlineError } from "../core/errors.ts";
import { cancellationError, throwIfCancelled } from "./error-text.ts";
import {
  restoreWorkerError,
  invalidWorkerResult,
  type RegexWorkerReply,
} from "./regex-worker-contract.ts";

export async function withRegexWorker<Input, Result, Output>(
  entry: URL,
  decode: (value: unknown) => RegexWorkerReply<Result> | undefined,
  timeoutMs: number,
  signal: AbortSignal | undefined,
  execute: (run: (input: Input) => Promise<Result>) => Promise<Output>,
  resourceLimits?: ResourceLimits,
): Promise<Output> {
  throwIfCancelled(signal);
  const worker = new Worker(entry, { resourceLimits });
  let failure: Error | undefined;
  let pending: { resolve: (result: Result) => void; reject: (error: Error) => void } | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const clear = () => {
    clearTimeout(timer);
    const previous = pending;
    pending = undefined;
    return previous;
  };
  const fail = (error: Error) => {
    failure ??= error;
    clear()?.reject(error);
  };
  const abort = () => fail(cancellationError());
  worker.on("message", (value: unknown) => {
    try {
      const reply = decode(value);
      if (!reply) fail(invalidWorkerResult());
      else if ("error" in reply) fail(restoreWorkerError(reply.error));
      else clear()?.resolve(reply.result);
    } catch (error) {
      fail(
        new HashlineError("REGEX_WORKER_FAILED", "Could not decode the regex worker result.", {
          cause: error,
        }),
      );
    }
  });
  worker.on("error", (error) =>
    fail(new HashlineError("REGEX_WORKER_FAILED", "Regex worker failed.", { cause: error })),
  );
  worker.on("exit", (exitCode) =>
    fail(
      new HashlineError("REGEX_WORKER_FAILED", "Regex worker exited before replying.", {
        facts: { exitCode },
      }),
    ),
  );
  signal?.addEventListener("abort", abort, { once: true });
  // Keep dispatch asynchronous so cancellation can be observed before posting a request.
  const run = (input: Input): Promise<Result> =>
    Promise.resolve().then(() => {
      throwIfCancelled(signal);
      if (failure) throw failure;
      return new Promise<Result>((resolve, reject) => {
        pending = { resolve, reject };
        timer = setTimeout(
          () =>
            fail(
              new HashlineError("REGEX_TIMEOUT", "Regex evaluation timed out.", {
                facts: { timeoutMs },
              }),
            ),
          timeoutMs,
        );
        try {
          worker.postMessage(input);
        } catch (error) {
          fail(
            new HashlineError("REGEX_WORKER_FAILED", "Could not send the regex request.", {
              cause: error,
            }),
          );
        }
      });
    });
  try {
    if (signal?.aborted) abort();
    return await execute(run);
  } finally {
    clear();
    signal?.removeEventListener("abort", abort);
    await worker.terminate();
  }
}
