import { access } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { installedExtension } from "../testing/installation.testing.ts";
import { runTestProcess } from "../testing/process.testing.ts";

test("npm archive without devDependencies → registered tools complete a real Pi workflow", async (t) => {
  const installation = await installedExtension(t, "packed");
  await access(join(installation.packageDir, "THIRD_PARTY_NOTICES.md"));
  await runTestProcess(
    process.execPath,
    [fileURLToPath(new URL("./npm-package.testing.ts", import.meta.url)), installation.entry],
    installation.root,
    installation.agentDir,
  );
});
