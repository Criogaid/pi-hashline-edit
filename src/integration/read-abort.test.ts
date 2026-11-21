import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setImmediate } from "node:timers/promises";
import { expectToolFailure } from "../pi/report-failure.testing.ts";
import { callTool } from "../pi/tool-call.testing.ts";
import {
  DEFAULT_CONFIG,
  makeGrepOverride,
  makeReadOverride,
} from "../pi/tool-factories.testing.ts";

test("abort during the scan's initial stat → read and grep report cancellation without an uncaught stream error", async (t) => {
  const cwd = await fs.mkdtemp(join(tmpdir(), "hashline-read-abort-"));
  t.after(() => fs.rm(cwd, { recursive: true, force: true }));
  const path = join(cwd, "source.txt");
  await fs.writeFile(path, "head\r\nneedle\r\ntail\n");
  const read = makeReadOverride(cwd, DEFAULT_CONFIG);
  const grep = makeGrepOverride(cwd, DEFAULT_CONFIG);
  const grepArgs = { path, pattern: "needle", literal: true };
  const cases = [
    { name: "read", tool: read, args: { path, limit: 1 }, scan: 1 },
    { name: "grep search", tool: grep, args: grepArgs, scan: 1 },
    { name: "grep re-read", tool: grep, args: grepArgs, scan: 2 },
  ];

  for (const { name, tool, args, scan } of cases) {
    await t.test(name, async (t) => {
      const controller = new AbortController();
      const open = fs.open;
      let opens = 0;
      let closes = 0;
      t.mock.method(fs, "open", async (...args: Parameters<typeof open>) => {
        const handle = await open(...args);
        // The scan opens with numeric flags. read's native MIME probe opens the same path with "r".
        if (args[0] === path && typeof args[1] === "number" && ++opens === scan) {
          assert.ok(handle instanceof EventEmitter);
          handle.on("close", () => closes++);
          const stat = handle.stat.bind(handle);
          t.mock.method(handle, "stat", async () => {
            const result = await stat({ bigint: true });
            controller.abort();
            return result;
          });
        }
        return handle;
      });
      syncBuiltinESMExports();
      try {
        await expectToolFailure(
          callTool(tool, args, { signal: controller.signal }),
          "OPERATION_ABORTED",
        );
        assert.equal(opens, scan);
        assert.equal(closes, 1);
        // Let Node deliver stream events queued by the rejected scan before the subtest ends.
        await setImmediate();
      } finally {
        t.mock.restoreAll();
        syncBuiltinESMExports();
      }
    });
  }
});
