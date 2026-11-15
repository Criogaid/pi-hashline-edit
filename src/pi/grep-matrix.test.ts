import assert from "node:assert/strict";
import { test } from "node:test";
import { MATRIX_SYNTAX } from "../core/search-matrix.testing.ts";
import { GREP_FLAGS } from "../core/search.ts";
import { makeMockGrep } from "./grep-rg.testing.ts";
const { DEFAULT_CONFIG } = await import("./tool-factories.testing.ts");
import { reportOf } from "./report.ts";
import { rejectsArgument } from "./argument-error.testing.ts";
import { callTool } from "./tool-call.testing.ts";

test("Cartesian JS syntax × case override → tool entry agrees with V8 before discovery", async (t) => {
  let discoveries = 0;
  const discover = async () => {
    discoveries++;
    return { code: 1, stderr: "", stopped: false };
  };
  const tool = makeMockGrep(process.cwd(), DEFAULT_CONFIG, {
    runRgPaths: discover,
    runRgLines: discover,
  });
  const patterns = [
    ...MATRIX_SYNTAX.map(([, pattern]) => pattern),
    "(",
    "(?i)a",
    "a++",
    "(?P<name>a)",
  ];
  let accepted = 0;
  let rejected = 0;
  for (const pattern of patterns) {
    for (const ignoreCase of [undefined, false, true]) {
      let field: "pattern[0]" | undefined;
      try {
        new RegExp(pattern, GREP_FLAGS);
      } catch (error) {
        if (!(error instanceof SyntaxError)) throw error;
        field = "pattern[0]";
      }
      const before = discoveries;
      const params = {
        pattern,
        literal: false,
        ...(ignoreCase === undefined ? {} : { ignoreCase }),
      };
      const result = callTool(tool, params);
      const context = JSON.stringify(params);
      if (field) {
        rejected++;
        await assert.rejects(result, rejectsArgument(field), context);
        assert.equal(discoveries, before, context);
      } else {
        accepted++;
        const value = await result;
        assert.equal(value.isError, undefined, context);
        assert.equal(reportOf(value, "grep")?.matches, 0, context);
        assert.equal(discoveries, before + 1, context);
      }
    }
  }
  t.diagnostic(
    JSON.stringify({
      syntaxInputs: patterns.length,
      accepted,
      rejected,
    }),
  );
  assert.ok(accepted > 0 && rejected > 0);
});
