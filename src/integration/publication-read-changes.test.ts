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
import { reportOf } from "../pi/report.ts";
import { expectToolFailure } from "../pi/report-failure.testing.ts";
import { PUBLICATION_NEXT, REREAD } from "../pi/report-schema.ts";
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
    args: { edits: [{ action: "append", body: ["after"] }] },
  },
  {
    name: "replace",
    make: (cwd: string, fusion?: ReturnType<typeof createActionFusionExecutor>) =>
      makeReplaceTool(cwd, DEFAULT_CONFIG, fusion),
    args: { replacements: [{ literal: true, find: BEFORE, replace: PUBLISHED }] },
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

const prePublicationCases = [
  { phase: "inspect target", mutation: mutationCases[2], observation: 1 },
  { phase: "revision recheck", mutation: mutationCases[0], observation: 2 },
  {
    phase: "no-op check",
    mutation: {
      ...mutationCases[1],
      args: { replacements: [{ literal: true, find: BEFORE, replace: BEFORE }] },
    },
    observation: 2,
  },
] as const;

for (const fused of [false, true]) {
  test(`concurrent change during post-publication read without then_run (${fused ? "Fusion enabled" : "plain"}) → succeeds and withholds stale anchors`, async (t) => {
    for (const mutation of mutationCases) {
      for (const disturbance of ["append", "delete"] as const) {
        await t.test(
          `${mutation.name}: ${disturbance} → retains publication and reports changed freshness`,
          async (t) => {
            const { directory, path } = await targetFile(
              t,
              mutation.name === "write create" ? undefined : BEFORE,
            );
            const fusion = fused
              ? createActionFusionExecutor(async () =>
                  assert.fail("command must not run without then_run"),
                )
              : undefined;
            const result = await withDisturbedRead(
              t,
              path,
              PUBLISHED,
              disturbance,
              (bytes) => bytes.equals(Buffer.from(PUBLISHED)),
              () => callTool(mutation.make(directory, fusion), { path, ...mutation.args }),
            );
            assert.equal(result.isError, undefined);
            const report = reportOf(
              result,
              mutation.name === "edit" ? "edit" : mutation.name === "replace" ? "replace" : "write",
            );
            assert.equal(report?.publication, "PUBLISHED");
            assert.equal(report?.next, REREAD);
            assert.doesNotMatch(text(result), /Updated anchors|retry the tool/);
            assert.equal(report?.then_run, undefined);
            assert.equal(report?.freshness, "changed");
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
        const report = reportOf(result, "write");
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
        assert.equal(reportOf(result, "write")?.publication, "PUBLISHED");
        assert.equal(reportOf(result, "write")?.then_run?.status, "succeeded");
        assert.equal(
          reportOf(result, "write")?.freshness,
          disturbance === "I/O failure" ? "unknown" : "changed",
        );
        assert.equal(reportOf(result, "write")?.next, REREAD);
        assert.doesNotMatch(text(result), /Updated anchors|retry the tool/);
        await assertTarget(path, PUBLISHED, disturbance);
      },
    );
  }
});

test("other I/O failure during post-publication read → retains the published post-process error", async (t) => {
  for (const fused of [false, true]) {
    await t.test(fused ? "Fusion enabled" : "plain", async (t) => {
      const { directory, path } = await targetFile(t, BEFORE);
      let commands = 0;
      const fusion = fused
        ? createActionFusionExecutor(async () => {
            commands++;
            return {
              status: "succeeded",
              result: { content: [{ type: "text", text: "checked" }] },
            };
          })
        : undefined;
      const ctx = await createToolContext(directory, t);
      await withDisturbedRead(
        t,
        path,
        PUBLISHED,
        "I/O failure",
        (bytes) => bytes.equals(Buffer.from(PUBLISHED)),
        () =>
          expectToolFailure(
            callTool(
              makeWriteOverride(directory, fusion),
              {
                path,
                content: PUBLISHED,
                mode: "overwrite",
                ...(fused ? { then_run: { command: "check" } } : {}),
              },
              { ctx },
            ),
            "POST_PROCESS_FAILED",
            (report) => {
              assert.equal(report.publication, "PUBLISHED");
              assert.equal(report.cause?.message, READ_FAILURE.message);
              assert.equal(report.cause?.code, "EIO");
              assert.equal(report.then_run?.status, fused ? "skipped" : undefined);
              assert.equal(report.next, PUBLICATION_NEXT.PUBLISHED);
            },
          ),
      );
      assert.equal(commands, 0);
      await assertTarget(path, PUBLISHED, "I/O failure");
    });
  }
});

test("concurrent change during pre-publication revision read → rejects without publishing and keeps retry advice", async (t) => {
  for (const { phase, mutation, observation } of prePublicationCases) {
    await t.test(`${phase} → NOT_PUBLISHED`, async (t) => {
      const { directory, path } = await targetFile(t, BEFORE);
      let targetReads = 0;
      await withDisturbedRead(
        t,
        path,
        BEFORE,
        "append",
        () => ++targetReads === observation,
        () =>
          expectToolFailure(
            callTool(mutation.make(directory), { path, ...mutation.args }),
            "FILE_CHANGED",
            (report) => {
              assert.equal(report.publication, "NOT_PUBLISHED");
              assert.equal(report.next, "Retry the call.");
            },
          ),
      );
      assert.equal(targetReads, observation);
      await assertTarget(path, BEFORE, "append");
    });
  }
});

test("target disappears or becomes a directory before publication → keeps the path error without publishing", async (t) => {
  for (const { phase, mutation, observation } of prePublicationCases) {
    for (const disturbance of ["missing", "directory"] as const) {
      await t.test(`${phase}: ${disturbance}`, async (t) => {
        const { directory, path } = await targetFile(t, BEFORE);
        const originalPath = join(directory, "original.txt");
        const nativeOpen = fs.promises.open;
        let targetReads = 0;
        t.mock.method(fs.promises, "open", async (...args: Parameters<typeof nativeOpen>) => {
          if (args[0] === path && ++targetReads === observation) {
            // Keep the displaced inode to prove the commit never changed its bytes.
            fs.renameSync(path, originalPath);
            if (disturbance === "directory") fs.mkdirSync(path);
          }
          return nativeOpen(...args);
        });
        syncBuiltinESMExports();
        try {
          await expectToolFailure(
            callTool(mutation.make(directory), { path, ...mutation.args }),
            disturbance === "missing" ? "PATH_NOT_FOUND" : "NOT_REGULAR_FILE",
            (report) => {
              assert.equal(
                report.message,
                disturbance === "missing" ? "Path not found." : "Path is not a regular file.",
              );
              assert.deepEqual(report.missing, disturbance === "missing" ? [path] : undefined);
              assert.equal(report.publication, "NOT_PUBLISHED");
              assert.equal(report.cause, undefined);
            },
          );
          assert.equal(targetReads, observation, "the intended target read must be disturbed");
          assert.deepEqual(await readFile(originalPath), Buffer.from(BEFORE));
          if (disturbance === "directory") assert.deepEqual(fs.readdirSync(path), []);
          else await assertTarget(path, BEFORE, "delete");
        } finally {
          t.mock.restoreAll();
          syncBuiltinESMExports();
        }
      });
    }
  }
});

test("file changes after the editable snapshot → rejects publication against the read bytes", async (t) => {
  for (const mutation of mutationCases.filter(
    ({ name }) => name === "edit" || name === "replace",
  )) {
    await t.test(mutation.name, async (t) => {
      const { directory, path } = await targetFile(t, BEFORE);
      const nativeOpen = fs.promises.open;
      let targetReads = 0;
      t.mock.method(fs.promises, "open", async (...args: Parameters<typeof nativeOpen>) => {
        if (args[0] === path && ++targetReads === 2) fs.appendFileSync(path, CONCURRENT_APPEND);
        return nativeOpen(...args);
      });
      syncBuiltinESMExports();
      try {
        await expectToolFailure(
          callTool(mutation.make(directory), { path, ...mutation.args }),
          "FILE_CHANGED",
          (report) => {
            assert.equal(report.publication, "NOT_PUBLISHED");
          },
        );
        assert.equal(targetReads, 2);
        await assertTarget(path, BEFORE, "append");
      } finally {
        t.mock.restoreAll();
        syncBuiltinESMExports();
      }
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
            edits: [{ action: "append", body: ["after"] }],
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
