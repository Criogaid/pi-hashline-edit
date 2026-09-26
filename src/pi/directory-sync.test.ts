import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { commitFile, FileMutationError } from "./file-commit.ts";

test("macOS attempts directory sync, tolerates unsupported operations, and preserves published I/O failures", async (t) => {
  const directory = await fs.mkdtemp(join(tmpdir(), "hashline-directory-sync-"));
  const nativeOpen = fs.open;
  const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
  let syncs = 0;
  let closes = 0;
  let failure: string | undefined;
  try {
    Object.defineProperty(process, "platform", { value: "darwin" });
    t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
      if (args[0] !== directory) return nativeOpen(...args);
      return {
        async sync() {
          syncs++;
          if (failure) throw Object.assign(new Error(failure), { code: failure });
        },
        async close() { closes++; },
      } as Awaited<ReturnType<typeof fs.open>>;
    });
    syncBuiltinESMExports();
    for (failure of [undefined, "EINVAL", "ENOTSUP", "EIO"]) {
      const path = join(directory, failure ?? "success");
      const commit = commitFile(path, "published\n");
      if (failure === "EIO") {
        await assert.rejects(commit, (error: unknown) => error instanceof FileMutationError && error.publication === "PUBLISHED" && /EIO/.test(error.message));
      } else {
        assert.equal((await commit).publication, "PUBLISHED");
      }
      assert.equal(await fs.readFile(path, "utf8"), "published\n");
    }
    assert.equal(syncs, 4);
    assert.equal(closes, 4);
  } finally {
    Object.defineProperty(process, "platform", platform);
    t.mock.restoreAll();
    syncBuiltinESMExports();
    await fs.rm(directory, { recursive: true, force: true });
  }
});
