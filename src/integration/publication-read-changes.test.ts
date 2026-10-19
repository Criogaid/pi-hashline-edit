/** Real file-handle races at publication and Fusion observation boundaries. */
import assert from "node:assert/strict";
import fs from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { createActionFusionExecutor } from "../pi/action-fusion.ts";
import { DEFAULT_CONFIG } from "../pi/config.ts";
import { makeEditOverride } from "../pi/edit-tool.ts";
import { byteRevision, commitFile, FileMutationError } from "../pi/file-commit.ts";
import { describeFailure, reportOf } from "../pi/report.ts";
import { expectToolFailure } from "../pi/report-failure.testing.ts";
import { REREAD } from "../pi/report-schema.ts";
import { makeReplaceTool } from "../pi/replace-tool.ts";
import { callTool, createToolContext } from "../pi/tool-call.testing.ts";
import { makeWriteOverride } from "../pi/write-tool.ts";

const BEFORE = "before\n";
const PUBLISHED = "before\nafter\n";
const CONCURRENT_APPEND = "other writer\n";
const READ_FAILURE = Object.assign(new Error("observation I/O failure"), { code: "EIO" });
type Disturbance = "append" | "delete" | "I/O failure";

async function targetFile(t: TestContext, content?: string) {
  const directory = await mkdtemp(join(tmpdir(), "hashline-publication-read-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "target.txt");
  if (content !== undefined) await writeFile(path, content);
  return { directory, path };
}

/** Disturb the real file after its bytes are read, before withFileRead accepts the observation. */
async function withDisturbedRead<T>(
  t: TestContext,
  path: string,
  expected: string,
  disturbance: Disturbance,
  ready: (bytes: Buffer) => boolean,
  run: () => Promise<T>,
): Promise<T> {
  const nativeOpen = fs.promises.open;
  let disturbed = false;
  t.mock.method(fs.promises, "open", async (...args: Parameters<typeof nativeOpen>) => {
    const handle = await nativeOpen(...args);
    if (args[0] === path) {
      const nativeRead = handle.readFile;
      t.mock.method(handle, "readFile", async (...readArgs: Parameters<typeof nativeRead>) => {
        const bytes = await nativeRead.apply(handle, readArgs);
        assert.ok(Buffer.isBuffer(bytes));
        if (!disturbed && ready(bytes)) {
          disturbed = true;
          assert.deepEqual(bytes, Buffer.from(expected));
          if (disturbance === "I/O failure") throw READ_FAILURE;
          if (disturbance === "delete") fs.unlinkSync(path);
          else fs.appendFileSync(path, CONCURRENT_APPEND);
        }
        return bytes;
      });
    }
    return handle;
  });
  syncBuiltinESMExports();
  try {
    return await run();
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
    assert.equal(disturbed, true, "the intended observation must be disturbed");
  }
}

async function assertTarget(path: string, original: string, disturbance: Disturbance) {
  if (disturbance === "delete") await assert.rejects(readFile(path), { code: "ENOENT" });
  else {
    const expected = original + (disturbance === "append" ? CONCURRENT_APPEND : "");
    assert.deepEqual(await readFile(path), Buffer.from(expected));
  }
}

function text(result: AgentToolResult<unknown>): string {
  return result.content.map((block) => (block.type === "text" ? block.text : "")).join("\n");
}

const mutationCases = [
  {
    name: "edit",
    make: (cwd: string, fusion?: ReturnType<typeof createActionFusionExecutor>) =>
      makeEditOverride(cwd, DEFAULT_CONFIG, fusion),
    args: { edits: [{ op: "append", body: ["after"] }] },
  },
  {
    name: "replace",
    make: (cwd: string, fusion?: ReturnType<typeof createActionFusionExecutor>) =>
      makeReplaceTool(cwd, DEFAULT_CONFIG, fusion),
    args: { replacements: [{ find: BEFORE, replace: PUBLISHED }] },
  },
  {
    name: "write overwrite",
    make: makeWriteOverride,
    args: { content: PUBLISHED, mode: "overwrite" },
  },
  {
    name: "write create",
    make: makeWriteOverride,
    args: { content: PUBLISHED, mode: "create" },
  },
] as const;

for (const fused of [false, true]) {
  test(`concurrent change during post-publication read without then_run (${fused ? "Fusion enabled" : "plain"}) → succeeds and withholds stale anchors`, async (t) => {
    for (const mutation of mutationCases) {
      for (const disturbance of ["append", "delete"] as const) {
        await t.test(
          `${mutation.name}: ${disturbance} → published without a stable revision`,
          async (t) => {
            const { directory, path } = await targetFile(
              t,
              mutation.name === "write create" ? undefined : BEFORE,
            );
            const fusion = fused ? createActionFusionExecutor() : undefined;
            const result = await withDisturbedRead(
              t,
              path,
              PUBLISHED,
              disturbance,
              (bytes) => bytes.equals(Buffer.from(PUBLISHED)),
              () => callTool(mutation.make(directory, fusion), { path, ...mutation.args }),
            );
            assert.equal(result.isError, undefined);
            assert.equal(reportOf(result)?.publication, "PUBLISHED");
            assert.equal(Object.hasOwn(result.details, "observedRevision"), false);
            assert.equal(result.details.publishedRevision, byteRevision(PUBLISHED));
            if (mutation.name !== "write create")
              assert.equal(result.details.baseRevision, byteRevision(BEFORE));
            assert.equal(reportOf(result)?.next, REREAD);
            assert.doesNotMatch(text(result), /Updated anchors|retry the tool/);
            assert.equal(reportOf(result)?.then_run, undefined);
            assert.equal(reportOf(result)?.freshness, "changed");
            await assertTarget(path, PUBLISHED, disturbance);
          },
        );
      }
    }
  });
}

for (const observation of [1, 2]) {
  test(`disturbance during pre-command observation ${observation} → skips then_run without retry advice or rollback`, async (t) => {
    for (const disturbance of ["append", "delete", "I/O failure"] as const) {
      await t.test(`${disturbance} → skips the command and preserves publication`, async (t) => {
        const { directory, path } = await targetFile(t, BEFORE);
        let mutationCompleted = false;
        let observations = 0;
        let commands = 0;
        const fusion = createActionFusionExecutor(
          async () => {
            commands++;
            return {
              status: "succeeded",
              result: { content: [{ type: "text", text: "checked" }] },
            };
          },
          (progress) => {
            if (progress.mutationCompleted) mutationCompleted = true;
          },
        );
        const ctx = await createToolContext(directory, t);
        const result = await withDisturbedRead(
          t,
          path,
          PUBLISHED,
          disturbance,
          () => mutationCompleted && ++observations === observation,
          () =>
            callTool(
              makeWriteOverride(directory, fusion),
              {
                path,
                content: PUBLISHED,
                mode: "overwrite",
                then_run: { command: "check" },
              },
              { ctx },
            ),
        );
        assert.equal(commands, 0);
        const report = reportOf(result);
        assert.equal(report?.publication, "PUBLISHED");
        assert.equal(report?.then_run?.status, "skipped");
        assert.equal(report?.freshness, disturbance === "I/O failure" ? "unknown" : "changed");
        if (disturbance === "I/O failure") {
          assert.equal(report?.freshnessError?.message, READ_FAILURE.message);
          assert.equal(report?.freshnessError?.code, "EIO");
        }
        assert.equal(report?.next, REREAD);
        assert.doesNotMatch(text(result), /retry the tool/);
        await assertTarget(path, PUBLISHED, disturbance);
      });
    }
  });
}

test("disturbance during post-command freshness read → retains publication and reports stale anchors", async (t) => {
  for (const disturbance of ["append", "delete", "I/O failure"] as const) {
    await t.test(
      `${disturbance} → freshness is ${disturbance === "I/O failure" ? "unknown" : "changed"} without retry advice`,
      async (t) => {
        const { directory, path } = await targetFile(t, BEFORE);
        let commands = 0;
        const fusion = createActionFusionExecutor(async () => {
          commands++;
          return { status: "succeeded", result: { content: [{ type: "text", text: "checked" }] } };
        });
        const ctx = await createToolContext(directory, t);
        const result = await withDisturbedRead(
          t,
          path,
          PUBLISHED,
          disturbance,
          () => commands > 0,
          () =>
            callTool(
              makeWriteOverride(directory, fusion),
              {
                path,
                content: PUBLISHED,
                mode: "overwrite",
                then_run: { command: "check" },
              },
              { ctx },
            ),
        );
        assert.equal(commands, 1);
        assert.equal(reportOf(result)?.publication, "PUBLISHED");
        assert.equal(reportOf(result)?.then_run?.status, "succeeded");
        assert.equal(
          reportOf(result)?.freshness,
          disturbance === "I/O failure" ? "unknown" : "changed",
        );
        assert.equal(reportOf(result)?.next, REREAD);
        assert.doesNotMatch(text(result), /Updated anchors|retry the tool/);
        await assertTarget(path, PUBLISHED, disturbance);
      },
    );
  }
});

test("other I/O failure during post-publication read → retains the published post-process error", async (t) => {
  const { path } = await targetFile(t, BEFORE);
  await withDisturbedRead(
    t,
    path,
    PUBLISHED,
    "I/O failure",
    (bytes) => bytes.equals(Buffer.from(PUBLISHED)),
    async () => {
      await assert.rejects(commitFile(path, PUBLISHED, { mode: "overwrite" }), (error: unknown) => {
        assert.ok(error instanceof FileMutationError);
        assert.equal(error.stage, "post_process");
        assert.equal(error.publication, "PUBLISHED");
        assert.equal(error.cause, READ_FAILURE);
        return true;
      });
    },
  );
  await assertTarget(path, PUBLISHED, "I/O failure");
});

test("concurrent change during pre-publication revision read → rejects without publishing and keeps retry advice", async (t) => {
  for (const phase of ["inspect target", "revision recheck", "no-op check"] as const) {
    await t.test(`${phase} → NOT_PUBLISHED`, async (t) => {
      const { path } = await targetFile(t, BEFORE);
      const revision = byteRevision(BEFORE);
      await withDisturbedRead(
        t,
        path,
        BEFORE,
        "append",
        () => true,
        async () => {
          await assert.rejects(
            commitFile(path, phase === "no-op check" ? BEFORE : PUBLISHED, {
              mode: "overwrite",
              ...(phase !== "inspect target" ? { baseRevision: revision } : {}),
            }),
            (error: unknown) => {
              assert.ok(error instanceof FileMutationError);
              assert.equal(error.publication, "NOT_PUBLISHED");
              assert.equal(error.errorCode, "FILE_CHANGED");
              assert.equal(
                describeFailure("write", error, { mutation: true }).next,
                "Retry the call.",
              );
              return true;
            },
          );
        },
      );
      await assertTarget(path, BEFORE, "append");
    });
  }
});

test("concurrent change during editable snapshot read → skips Fusion with NOT_PUBLISHED and retry advice", async (t) => {
  const { directory, path } = await targetFile(t, BEFORE);
  let commands = 0;
  const fusion = createActionFusionExecutor(async () => {
    commands++;
    return { status: "succeeded", result: { content: [{ type: "text", text: "checked" }] } };
  });
  const ctx = await createToolContext(directory, t);
  await withDisturbedRead(
    t,
    path,
    BEFORE,
    "append",
    () => true,
    async () => {
      await expectToolFailure(
        callTool(
          makeEditOverride(directory, DEFAULT_CONFIG, fusion),
          {
            path,
            edits: [{ op: "append", body: ["after"] }],
            then_run: { command: "check" },
          },
          { ctx },
        ),
        "FILE_CHANGED",
        (report) => {
          assert.equal(report.publication, "NOT_PUBLISHED");
          assert.equal(report.then_run?.status, "skipped");
          assert.equal(report.next, "Retry the call.");
        },
      );
    },
  );
  assert.equal(commands, 0);
  await assertTarget(path, BEFORE, "append");
});
