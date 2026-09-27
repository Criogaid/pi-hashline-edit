import { createJiti } from "jiti";

// Worker threads do not inherit Pi's TypeScript loader for installed packages.
await createJiti(import.meta.url).import("./replace-worker.ts");
