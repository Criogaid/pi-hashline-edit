import assert from "node:assert/strict";
import { test } from "node:test";
import { MATRIX_FLAGS, MATRIX_SYNTAX } from "../core/search-matrix.testing.ts";
import { makeGrepOverrideWithBackend } from "./grep-tool.ts";
import { DEFAULT_CONFIG } from "./config.ts";
import { reportOf } from "./report.ts";
import { rejectsArgument } from "./argument-error.testing.ts";
import { callTool } from "./tool-call.testing.ts";

test("Cartesian JS syntax × all flag combinations → tool entry agrees with V8 before discovery", async (t) => {
  let discoveries = 0;
  const discover = async () => {
    discoveries++;
    return { code: 1, stderr: "", stopped: false };
  };
  const tool = makeGrepOverrideWithBackend(process.cwd(), DEFAULT_CONFIG, {
    runRgPaths: discover,
    runRgLines: discover,
  });
  const flagsCases = [
    ...["", "d", "g", "dg"].flatMap((prefix) => MATRIX_FLAGS.map((flags) => prefix + flags)),
    "uv",
    "imuv",
    "x",
    "I",
    "u v",
    "gg",
    "ii",
    "mmuu",
  ];
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
    for (const flags of flagsCases) {
      const normalizedFlags = [...new Set(flags)].join("");
      let field: "flags" | "pattern" | undefined;
      try {
        new RegExp("", normalizedFlags);
      } catch (error) {
        if (!(error instanceof SyntaxError)) throw error;
        field = "flags";
      }
      if (!field) {
        try {
          new RegExp(pattern, normalizedFlags);
        } catch (error) {
          if (!(error instanceof SyntaxError)) throw error;
          field = "pattern";
        }
      }
      const before = discoveries;
      const result = callTool(tool, { pattern, flags, literal: false });
      const context = JSON.stringify({ pattern, flags });
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
      flagInputs: flagsCases.length,
      accepted,
      rejected,
    }),
  );
  assert.ok(accepted > 0 && rejected > 0);
});
