import { parentPort, workerData } from "node:worker_threads";
import { applyReplacements } from "./replace-apply.ts";
import { errorMessage } from "./error-text.ts";

try {
  const { source, rules } = workerData;
  parentPort!.postMessage({ result: applyReplacements(source, rules) });
} catch (error) {
  parentPort!.postMessage({ error: errorMessage(error) });
}
