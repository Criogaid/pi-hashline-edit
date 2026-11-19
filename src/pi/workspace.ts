import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExecResult, ExtensionAPI } from "@earendil-works/pi-coding-agent";

function workspaceFrom(result: ExecResult, cwd: string): string | undefined {
  if (result.code === 0 && !result.killed && !result.truncated && isAbsolute(cwd)) return cwd;
}

/** Ask the OS in the loader's cwd without starting Node with the host's preloads. */
export async function resolveWorkspace(pi: Pick<ExtensionAPI, "exec">): Promise<string> {
  let result: ExecResult;
  let stdout: string;
  if (process.platform === "win32") {
    const system32 = join(process.env.SystemRoot ?? "C:\\Windows", "System32");
    const script = fileURLToPath(new URL("./workspace-cwd.js", import.meta.url));
    const probe = await pi.exec(join(system32, "cscript.exe"), [
      "//B",
      "//NoLogo",
      "//E:JScript",
      script,
    ]);
    try {
      const cwd = workspaceFrom(probe, decodeURIComponent(probe.stdout));
      if (cwd !== undefined) return cwd;
    } catch (error) {
      // If the script host emits a diagnostic on stdout, the payload may not be URI-encoded.
      if (!(error instanceof URIError)) throw error;
    }
    result = await pi.exec(join(system32, "WindowsPowerShell/v1.0/powershell.exe"), [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false); [Console]::Write([Environment]::CurrentDirectory)",
    ]);
    stdout = result.stdout;
  } else {
    result = await pi.exec("/bin/pwd", ["-P"]);
    stdout = result.stdout.replace(/\n$/, "");
  }

  const cwd = workspaceFrom(result, stdout);
  if (cwd !== undefined) return cwd;
  throw new Error(`Unable to resolve the Pi workspace (exit ${result.code})`, {
    cause: result.stderr || undefined,
  });
}
