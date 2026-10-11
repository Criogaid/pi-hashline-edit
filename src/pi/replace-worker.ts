import { parentPort } from "node:worker_threads";
import { applyReplacements } from "../core/replace.ts";
import type { ReplacementRequest } from "./replace-worker-contract.ts";
// report-cause.ts only: the worker runs on plain jiti without the host's typebox mapping.
import { workerFailure } from "./report-cause.ts";

// The sole sender supplies rules already validated at the tool entry point.
parentPort!.on("message", ({ source, rules }: ReplacementRequest) => {
  try {
    parentPort!.postMessage({ result: applyReplacements(source, rules) });
  } catch (error) {
    parentPort!.postMessage(workerFailure(error));
  }
});
