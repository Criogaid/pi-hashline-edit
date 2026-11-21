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
  signal: AbortSignal,
  execute: (run: (input: Input) => Promise<Result>) => Promise<Output>,
  resourceLimits?: ResourceLimits,
): Promise<Output> {
  throwIfCancelled(signal);
  // A data URL accepts inherited --input-type while the imported file retains its own module type.
  const bootstrap = new URL(
    `data:text/javascript,${encodeURIComponent(`import ${JSON.stringify(entry.href)};`)}`,
  );
  const worker = new Worker(bootstrap, { resourceLimits });
  let failure: Error | undefined;
  /** The request awaiting a reply, with its timeout. */
  let pending:
    | {
        readonly resolve: (result: Result) => void;
        readonly reject: (error: Error) => void;
        readonly timer: ReturnType<typeof setTimeout>;
      }
    | undefined;
  let termination: ReturnType<Worker["terminate"]> | undefined;
  const terminate = () => (termination ??= worker.terminate());
  const clear = () => {
    const previous = pending;
    pending = undefined;
    clearTimeout(previous?.timer);
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
  signal.addEventListener("abort", abort, { once: true });
  // Keep dispatch asynchronous so cancellation can be observed before posting a request.
  const run = (input: Input): Promise<Result> =>
    Promise.resolve().then(() => {
      throwIfCancelled(signal);
      if (failure) throw failure;
      return new Promise<Result>((resolve, reject) => {
        const timer = setTimeout(() => {
          fail(
            new HashlineError("REGEX_TIMEOUT", "Regex evaluation timed out.", {
              facts: { timeoutMs },
            }),
          );
          // A grep caller may still be scanning for NUL after evaluation times out.
          void terminate();
        }, timeoutMs);
        pending = { resolve, reject, timer };
        worker.postMessage(input);
      });
    });
  try {
    return await execute(run);
  } finally {
    clear();
    signal.removeEventListener("abort", abort);
    await terminate();
  }
}
