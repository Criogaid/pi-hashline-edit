// Run in a fresh Node process so global loaders and module caches cannot supply devDependencies.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { createJiti } from "../../node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/jiti-static-loader.js";
import { VIRTUAL_MODULES } from "../../node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/virtual-modules.js";

const entry = process.argv[2];
assert.throws(() => createRequire(entry).resolve("typebox/type"), { code: "MODULE_NOT_FOUND" });
const jiti = createJiti(import.meta.url, {
  moduleCache: false,
  virtualModules: VIRTUAL_MODULES,
  tryNative: false,
});
const factory = await jiti.import<unknown>(entry, { default: true });
assert.equal(typeof factory, "function");
