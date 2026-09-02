import { rm } from "node:fs/promises";
import { resolve } from "node:path";

// The renderer only requests the WebP sheets and packed gzip animation data.
// Keep extraction originals in the workspace, but never ship them in Sites builds.
const generatedOnly = [
  "dist/client/effects/sheets",
  "dist/client/effects/anim",
  "dist/client/effects/anim-s",
  // These immutable WebP assets are already served from the pinned jsDelivr
  // archive URL in AnssStage. Keeping a second copy makes Sites exceed its
  // expanded archive limit without improving the normal request path.
  "dist/client/effects/sheets-webp",
  "dist/client/effects/sprites-webp",
  "dist/client/effects/strips-webp",
];

await Promise.all(generatedOnly.map((entry) => rm(resolve(entry), { recursive: true, force: true })));
