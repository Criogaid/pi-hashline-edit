/** Isolated installed-package layouts with only npm's locked production dependency tree. */
import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import type { TestContext } from "node:test";
import manifest from "../../package.json" with { type: "json" };
import lock from "../../package-lock.json" with { type: "json" };
import { runTestProcess } from "./process.testing.ts";

const repository = fileURLToPath(new URL("../../", import.meta.url));

export async function installedExtension(t: TestContext, source: "source" | "packed" = "source") {
  const root = await mkdtemp(join(tmpdir(), "hashline-install-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const packageDir = join(root, "node_modules", manifest.name);
  const agentDir = join(root, "agent");
  await mkdir(packageDir, { recursive: true });
  await mkdir(agentDir);
  for (const [path, metadata] of Object.entries(lock.packages)) {
    if (
      !path ||
      ("dev" in metadata && metadata.dev) ||
      ("devOptional" in metadata && metadata.devOptional)
    )
      continue;
    const dependency = join(repository, path);
    try {
      await stat(dependency);
    } catch (error) {
      if (
        error instanceof Error &&
        "code" in error &&
        error.code === "ENOENT" &&
        "optional" in metadata &&
        metadata.optional
      )
        continue;
      throw error;
    }
    // Copy instead of linking: dependency resolution must not walk back into the checkout.
    await cp(dependency, join(root, path), {
      recursive: true,
      dereference: true,
      filter: (candidate) => candidate !== join(dependency, "node_modules"),
    });
  }
  if (source === "packed") {
    const npmCli =
      process.env.npm_execpath ??
      join(
        dirname(process.execPath),
        process.platform === "win32"
          ? "node_modules/npm/bin/npm-cli.js"
          : "../lib/node_modules/npm/bin/npm-cli.js",
      );
    await runTestProcess(
      process.execPath,
      [npmCli, "pack", "--ignore-scripts", "--pack-destination", root],
      repository,
      agentDir,
    );
    const archives = (await readdir(root)).filter((name) => name.endsWith(".tgz"));
    assert.equal(archives.length, 1, "npm pack must produce one archive");
    await runTestProcess(
      "tar",
      ["-xzf", archives[0], "-C", relative(root, packageDir), "--strip-components=1"],
      root,
      agentDir,
    );
  } else {
    await cp(join(repository, "src"), join(packageDir, "src"), { recursive: true });
    await cp(join(repository, "package.json"), join(packageDir, "package.json"));
  }
  return { root, packageDir, agentDir, entry: join(packageDir, manifest.pi.extensions[0]) };
}
