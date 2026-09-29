import { parentPort, workerData } from "node:worker_threads";
import { applyReplacements } from "../core/replace.ts";
import { errorMessage } from "../core/errors.ts";

try {
  const { source, rules } = workerData;
  parentPort!.postMessage({ result: applyReplacements(source, rules) });
} catch (error) {
  parentPort!.postMessage({ error: errorMessage(error) });
}
