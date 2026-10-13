/** grep's regex worker: runs core/search on the requests of grep-search's pool. */
import { parentPort } from "node:worker_threads";
import { searchLines, searchText, type LineSearchInput, type SearchInput } from "../core/search.ts";
import { workerFailure } from "./report-cause.ts";

// Query syntax and options have already passed the tool entry point.
parentPort!.on("message", (input: SearchInput | LineSearchInput) => {
  try {
    const result = "lines" in input ? searchLines(input) : searchText(input);
    parentPort!.postMessage({ result });
  } catch (error) {
    parentPort!.postMessage(workerFailure(error));
  }
});
