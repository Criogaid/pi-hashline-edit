import { parentPort, workerData } from "node:worker_threads";
import { applyReplacements } from "../core/replace.ts";
import { errorMessage, HashlineError } from "../core/errors.ts";

// Errors cross the thread boundary as their code, message, and facts; an unclassified one as its cause text.
try {
  const { source, rules } = workerData;
  parentPort!.postMessage({ result: applyReplacements(source, rules) });
} catch (error) {
  parentPort!.postMessage({
    error:
      error instanceof HashlineError
        ? { code: error.errorCode, message: error.message, facts: error.facts }
        : {
            code: "REGEX_WORKER_FAILED",
            message: "Regex evaluation failed.",
            cause: errorMessage(error),
          },
  });
}
