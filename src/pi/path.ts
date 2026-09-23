import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const UNICODE_SPACES = /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g;
const WINDOWS_SHELL_DRIVE = /^\/(?:mnt\/|cygdrive\/)?([a-z])(?:\/(.*))?$/i;

/** Resolve model-supplied paths with the same input conventions as Pi's built-in file tools. */
export function canonicalPath(cwd: string, path: string): string {
	let normalized = path.replace(UNICODE_SPACES, " ");
	if (normalized.startsWith("@")) normalized = normalized.slice(1);
	if (process.platform === "win32" && normalized.startsWith("/") && !normalized.startsWith("//") && !normalized.includes("\\")) {
		const match = WINDOWS_SHELL_DRIVE.exec(normalized);
		if (match) normalized = `${match[1]!.toUpperCase()}:\\${match[2]?.replaceAll("/", "\\") ?? ""}`;
	}
	if (normalized === "~") normalized = homedir();
	else if (normalized.startsWith("~/") || (process.platform === "win32" && normalized.startsWith("~\\"))) {
		normalized = join(homedir(), normalized.slice(2));
	}
	if (normalized.startsWith("file://")) normalized = fileURLToPath(normalized);
	return isAbsolute(normalized) ? resolve(normalized) : resolve(cwd, normalized);
}
