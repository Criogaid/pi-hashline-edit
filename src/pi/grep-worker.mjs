import { createJiti } from "jiti";

// Installed packages need an explicit TypeScript loader in worker threads.
await createJiti(import.meta.url).import("./grep-worker.ts");
