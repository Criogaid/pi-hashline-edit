import { parentPort } from "node:worker_threads";
import { searchText, type SearchInput } from "../core/search.ts";
import { workerFailure } from "./report-cause.ts";

// Query syntax and options have already passed the tool entry point.
parentPort!.on("message", (input: SearchInput) => {
  try {
    parentPort!.postMessage({ result: searchText(input) });
  } catch (error) {
    parentPort!.postMessage(workerFailure(error));
  }
});
