import { defineConfig } from "vite";
import path from "node:path";
import fs from "node:fs";
import crypto from "node:crypto";

/** Content hash of every sprite file, injected as __SPRITE_VERSION__ so the
 *  renderer's persistent sprite cache (packages/renderer/src/spriteCache.ts)
 *  is invalidated exactly when the art changes, not on every deploy. */
function spriteVersion(): string {
  const root = path.resolve(__dirname, "public/data/sprites");
  const hash = crypto.createHash("sha256");
  const files = (fs.readdirSync(root, { recursive: true }) as string[]).filter((f) =>
    fs.statSync(path.join(root, f)).isFile(),
  );
  for (const f of files.sort()) {
    hash.update(f);
    hash.update(fs.readFileSync(path.join(root, f)));
  }
  return hash.digest("hex").slice(0, 16);
}

export default defineConfig(({ command }) => ({
  // Build only: in dev, sprites are re-extracted without a restart, so the
  // renderer skips the persistent cache entirely (no version = no cache).
  define: command === "build" ? { __SPRITE_VERSION__: JSON.stringify(spriteVersion()) } : {},
  // Relative base so the build works from a subpath on GitHub/Codeberg Pages.
  base: "./",
  server: {
    // Allows the dev server to be reached through an ngrok tunnel (its
    // subdomain changes per session, so a fixed allowlist entry isn't
    // practical). Dev-only, never applies to the built static site.
    allowedHosts: true,
  },
  resolve: {
    alias: {
      "@factoriotools/engine": path.resolve(__dirname, "../../packages/engine/src/index.ts"),
      "@factoriotools/renderer": path.resolve(__dirname, "../../packages/renderer/src/index.ts"),
    },
  },
}));
