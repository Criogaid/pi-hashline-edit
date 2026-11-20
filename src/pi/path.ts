/**
 * Path canonicalization and lossless re-serialization for cross-platform tool
 * input, and the form a path takes in a card's call line.
 *
 * @module pi-hashline-edit/pi
 */

import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const UNICODE_SPACES = /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g;
const WINDOWS_SHELL_DRIVE = /^\/(?:mnt\/|cygdrive\/)?([a-z])(?:\/(.*))?$/is;
const LOCALHOST_UNC_PATH = /^\\\\(localhost)\\/i;
const LOCALHOST_UNC_URL = /^file:\/\/\/\/localhost\//i;

/** Resolve model-supplied paths with the same input conventions as Pi's built-in file tools. */
export function canonicalPath(cwd: string, path: string): string {
  let normalized = path.replace(UNICODE_SPACES, " ");
  if (normalized.startsWith("@")) normalized = normalized.slice(1);
  if (
    process.platform === "win32" &&
    normalized.startsWith("/") &&
    !normalized.startsWith("//") &&
    !normalized.includes("\\")
  ) {
    const match = WINDOWS_SHELL_DRIVE.exec(normalized);
    if (match) normalized = `${match[1].toUpperCase()}:\\${match[2]?.replaceAll("/", "\\") ?? ""}`;
  }
  if (normalized === "~") normalized = homedir();
  else if (
    normalized.startsWith("~/") ||
    (process.platform === "win32" && normalized.startsWith("~\\"))
  ) {
    normalized = join(homedir(), normalized.slice(2));
  }
  if (normalized.startsWith("file://")) {
    // Parse the four-slash UNC form with a dotted host so URL parsing retains the
    // authority and fileURLToPath applies its Windows separator checks.
    const localhost = process.platform === "win32" && LOCALHOST_UNC_URL.test(normalized);
    normalized = localhost
      ? fileURLToPath(normalized.replace(LOCALHOST_UNC_URL, "file://localhost./")).replace(
          /^\\\\localhost\.\\/,
          "\\\\localhost\\",
        )
      : fileURLToPath(normalized);
  }
  return resolve(cwd, normalized);
}

/** Return a readable path that resolves back to the same file through the tools' input syntax. */
export function serializePath(cwd: string, path: string): string {
  const absolute = resolve(cwd, path);
  const rel = relative(cwd, absolute);
  const local = rel && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
  // Windows accepts "/" too: one separator keeps paths alike inside and outside the cwd.
  const native = local ? rel : absolute;
  const candidate = sep === "\\" ? native.replaceAll(sep, "/") : native;
  // A file URL preserves names whose spaces are normalized on input, and keeps headers single-line.
  if (!/[\r\n]/.test(candidate)) {
    if (canonicalPath(cwd, candidate) === absolute) return candidate;
    if (local && canonicalPath(cwd, `./${candidate}`) === absolute) return `./${candidate}`;
  }
  const url = pathToFileURL(absolute);
  const localhost = LOCALHOST_UNC_PATH.exec(absolute)?.[1];
  return localhost === undefined ? url.href : `file:////${localhost}${url.pathname}`;
}

/**
 * A path inside the home directory with `~` in place of that directory, the form Pi's built-in
 * cards display; a relative path or a path elsewhere is returned unchanged.
 */
export function shortenHomePath(path: string): string {
  const home = homedir();
  if (!home || !isAbsolute(path)) return path;
  const rel = relative(home, path);
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return path;
  return rel ? `~${sep}${rel}` : "~";
}
