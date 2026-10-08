/** Keep npm's test entry points independent of personal Pi settings and Node loaders. */
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { testEnvironment } from "./process.testing.ts";

const SUITE_TIMEOUT_MS = 10 * 60 * 1000;
const suites = {
  unit: ["src/core/*.test.ts", "src/pi/*.test.ts"],
  integration: ["src/integration/*.test.ts"],
};
const suite = process.argv[2];
if (suite !== "unit" && suite !== "integration")
  throw new Error("Expected unit or integration suite");
const agentDir = mkdtempSync(join(tmpdir(), "hashline-test-agent-"));
try {
  const result = spawnSync(
    process.execPath,
    ["--test", ...process.argv.slice(3), ...suites[suite]],
    {
      cwd: fileURLToPath(new URL("../../", import.meta.url)),
      env: testEnvironment(agentDir),
      stdio: "inherit",
      timeout: SUITE_TIMEOUT_MS,
    },
  );
  if (result.error) throw result.error;
  if (result.signal) throw new Error(`Test suite stopped by ${result.signal}`);
  process.exitCode = result.status ?? 1;
} finally {
  rmSync(agentDir, { recursive: true, force: true });
}
