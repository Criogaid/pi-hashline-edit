import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { installedExtension } from "../testing/installation.testing.ts";
import { runTestProcess } from "../testing/process.testing.ts";

test("npm archive without devDependencies → registered tools complete a real Pi workflow", async (t) => {
  const installation = await installedExtension(t, "packed");
  await runTestProcess(
    process.execPath,
    [fileURLToPath(new URL("./npm-package.testing.ts", import.meta.url)), installation.entry],
    installation.root,
    installation.agentDir,
  );
});
