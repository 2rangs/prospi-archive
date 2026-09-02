import { rm } from "node:fs/promises";
import { resolve } from "node:path";

// The renderer only requests the WebP sheets and packed gzip animation data.
// Keep extraction originals in the workspace, but never ship them in Sites builds.
const generatedOnly = [
  "dist/client/effects/sheets",
  "dist/client/effects/anim",
  "dist/client/effects/anim-s",
];

await Promise.all(generatedOnly.map((entry) => rm(resolve(entry), { recursive: true, force: true })));
