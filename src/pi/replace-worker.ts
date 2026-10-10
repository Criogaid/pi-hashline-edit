import { parentPort, workerData } from "node:worker_threads";
import { applyReplacements, type Replacement } from "../core/replace.ts";
// report-cause.ts only: the worker runs on plain jiti without the host's typebox mapping.
import { workerFailure } from "./report-cause.ts";

try {
  // The sole production sender forwards rules already validated by the tool entry point.
  const { source, rules }: { readonly source: string; readonly rules: readonly Replacement[] } =
    workerData;
  parentPort!.postMessage({ result: applyReplacements(source, rules) });
} catch (error) {
  parentPort!.postMessage(workerFailure(error));
}
