import { parentPort, workerData } from "node:worker_threads";
import { applyReplacements } from "../core/replace.ts";
import { HashlineError } from "../core/errors.ts";
import { decodeWorkerRequest, workerFailure } from "./replace-worker-contract.ts";

try {
  const request = decodeWorkerRequest(workerData);
  if (!request)
    throw new HashlineError("REGEX_WORKER_FAILED", "Regex worker received invalid request data.");
  parentPort!.postMessage({ result: applyReplacements(request.source, request.rules) });
} catch (error) {
  parentPort!.postMessage(workerFailure(error));
}
