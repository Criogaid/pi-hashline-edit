import { access } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { installedExtension } from "../testing/installation.testing.ts";
import { runTestProcess } from "../testing/process.testing.ts";

for (const source of ["source", "packed"] as const) {
  test(`${source} installation without devDependencies → real Pi workflow and argument diagnostics`, async (t) => {
    const installation = await installedExtension(t, source);
    if (source === "packed") await access(join(installation.packageDir, "THIRD_PARTY_NOTICES.md"));
    await runTestProcess(
      process.execPath,
      [fileURLToPath(new URL("./npm-package.testing.ts", import.meta.url)), installation.entry],
      installation.root,
      installation.agentDir,
    );
  });
}
