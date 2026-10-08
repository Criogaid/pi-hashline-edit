import { execFile as execFileCallback } from "node:child_process";
import { cp, mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import manifest from "../../package.json" with { type: "json" };
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);
const LOAD_TIMEOUT_MS = 30_000;

test("extension installed without devDependencies → loads through Pi's virtual modules", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "hashline-extension-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repository = fileURLToPath(new URL("../../", import.meta.url));
  await cp(join(repository, "src"), join(root, "src"), { recursive: true });
  await cp(join(repository, "package.json"), join(root, "package.json"));
  // Link only declared runtime packages; their own transitive dependencies stay resolvable.
  for (const dependency of Object.keys(manifest.dependencies)) {
    const destination = join(root, "node_modules", dependency);
    await mkdir(dirname(destination), { recursive: true });
    await symlink(join(repository, "node_modules", dependency), destination, "junction");
  }
  const entry = join(root, "src", "index.ts");
  await execFile(
    process.execPath,
    [fileURLToPath(new URL("./extension-loading.testing.ts", import.meta.url)), entry],
    {
      env: { ...process.env, NODE_OPTIONS: "", NODE_PATH: "" },
      timeout: LOAD_TIMEOUT_MS,
    },
  );
});
