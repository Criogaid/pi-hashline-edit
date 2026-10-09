import { parentPort, workerData } from "node:worker_threads";
import { applyReplacements } from "../core/replace.ts";
import { errorMessage, HashlineError } from "../core/errors.ts";

// Errors cross the thread boundary as their code and message.
try {
  const { source, rules } = workerData;
  parentPort!.postMessage({ result: applyReplacements(source, rules) });
} catch (error) {
  parentPort!.postMessage({
    error: {
      code: error instanceof HashlineError ? error.errorCode : "REGEX_WORKER_FAILED",
      message: errorMessage(error),
    },
  });
}
