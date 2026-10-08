/** Isolated installed-package layouts with only npm's locked production dependency tree. */
import { cp, mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { TestContext } from "node:test";
import manifest from "../../package.json" with { type: "json" };
import lock from "../../package-lock.json" with { type: "json" };

const repository = fileURLToPath(new URL("../../", import.meta.url));

export async function installedExtension(t: TestContext) {
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
  await cp(join(repository, "src"), join(packageDir, "src"), { recursive: true });
  await cp(join(repository, "package.json"), join(packageDir, "package.json"));
  return { root, packageDir, agentDir, entry: join(packageDir, manifest.pi.extensions[0]) };
}
