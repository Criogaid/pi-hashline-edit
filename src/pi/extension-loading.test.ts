import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { installedExtension } from "../testing/installation.testing.ts";
import { runTestProcess } from "../testing/process.testing.ts";

test("extension installed without devDependencies → loads through Pi's virtual modules", async (t) => {
  const installation = await installedExtension(t);
  await runTestProcess(
    process.execPath,
    [fileURLToPath(new URL("./extension-loading.testing.ts", import.meta.url)), installation.entry],
    installation.root,
    installation.agentDir,
  );
});
