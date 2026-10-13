/** Keep npm's test entry points independent of personal Pi settings and Node loaders. */
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { testEnvironment } from "./process.testing.ts";

const unit = ["src/core/*.test.ts", "src/pi/*.test.ts"];
const integration = ["src/integration/*.test.ts"];
// Cartesian matrices take minutes per test; unit and integration skip them, `cartesian` runs only them.
const CARTESIAN = "^Cartesian ";
const suites = {
  unit: { files: unit, filter: `--test-skip-pattern=${CARTESIAN}`, timeoutMs: 10 * 60 * 1000 },
  integration: {
    files: integration,
    filter: `--test-skip-pattern=${CARTESIAN}`,
    timeoutMs: 10 * 60 * 1000,
  },
  cartesian: {
    files: [...unit, ...integration],
    filter: `--test-name-pattern=${CARTESIAN}`,
    timeoutMs: 60 * 60 * 1000,
  },
};
const suite = process.argv[2];
if (suite !== "unit" && suite !== "integration" && suite !== "cartesian")
  throw new Error("Expected unit, integration, or cartesian suite");
const { files, filter, timeoutMs } = suites[suite];
const agentDir = mkdtempSync(join(tmpdir(), "hashline-test-agent-"));
try {
  const result = spawnSync(
    process.execPath,
    ["--test", filter, ...process.argv.slice(3), ...files],
    {
      cwd: fileURLToPath(new URL("../../", import.meta.url)),
      env: testEnvironment(agentDir),
      stdio: "inherit",
      timeout: timeoutMs,
    },
  );
  if (result.error) throw result.error;
  if (result.signal) throw new Error(`Test suite stopped by ${result.signal}`);
  process.exitCode = result.status ?? 1;
} finally {
  rmSync(agentDir, { recursive: true, force: true });
}
