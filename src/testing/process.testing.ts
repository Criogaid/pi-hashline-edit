/** Own the environment used by test runners and isolated package probes. */
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);
const PROCESS_TIMEOUT_MS = 60_000;

export function testEnvironment(agentDir: string): NodeJS.ProcessEnv {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => {
      const name = key.toUpperCase();
      return (
        !["NODE_OPTIONS", "NODE_PATH", "PI_CODING_AGENT_DIR"].includes(name) &&
        !name.startsWith("JITI_")
      );
    }),
  );
  return { ...env, PI_CODING_AGENT_DIR: agentDir };
}

/** Start a bounded child without shell interpretation or inherited Node loaders. */
export async function runTestProcess(
  command: string,
  args: readonly string[],
  cwd: string,
  agentDir: string,
) {
  return execFile(command, args, {
    cwd,
    env: testEnvironment(agentDir),
    timeout: PROCESS_TIMEOUT_MS,
  });
}
