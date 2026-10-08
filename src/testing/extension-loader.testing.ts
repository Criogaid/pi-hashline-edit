/** Use Pi's embedded-runtime module mapping against an isolated extension installation. */
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { createJiti } from "../../node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/jiti-static-loader.js";
import { VIRTUAL_MODULES } from "../../node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/virtual-modules.js";

export async function loadInstalledExtension(entry: string): Promise<ExtensionFactory> {
  assert.throws(() => createRequire(entry).resolve("typebox/type"), { code: "MODULE_NOT_FOUND" });
  const jiti = createJiti(import.meta.url, {
    moduleCache: false,
    virtualModules: VIRTUAL_MODULES,
    tryNative: false,
  });
  const factory = await jiti.import<ExtensionFactory>(entry, { default: true });
  assert.equal(typeof factory, "function");
  return factory;
}
