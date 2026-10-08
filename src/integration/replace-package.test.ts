import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { installedExtension } from "../testing/installation.testing.ts";
import { runTestProcess } from "../testing/process.testing.ts";

// Workers have their own loader; an installed worker must resolve only production dependencies.
test("regex worker starts from an installed-package path", async (t) => {
  const installation = await installedExtension(t);
  await runTestProcess(
    process.execPath,
    [
      fileURLToPath(new URL("./replace-package.testing.ts", import.meta.url)),
      installation.packageDir,
    ],
    installation.root,
    installation.agentDir,
  );
});
