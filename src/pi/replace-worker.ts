import { parentPort, workerData } from "node:worker_threads";
import { applyReplacements } from "../core/replace.ts";
import { errorMessage, HashlineError } from "../core/errors.ts";
import type { WorkerMessage } from "./replace-worker-protocol.ts";

// Worker input is produced by the validated replace entry point. Output crosses a schema boundary.
let response: WorkerMessage;
try {
  const { source, rules } = workerData;
  response = { status: "success", result: applyReplacements(source, rules) };
} catch (error) {
  response =
    error instanceof HashlineError
      ? { status: "failure", error: error.descriptor() }
      : {
          status: "failure",
          error: new HashlineError("REGEX_WORKER_FAILED", "Regex evaluation failed.").descriptor(),
          cause: {
            name: error instanceof Error ? error.name : "ThrownValue",
            message: errorMessage(error),
          },
        };
}
parentPort!.postMessage(response);
