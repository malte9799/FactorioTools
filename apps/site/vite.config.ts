import { defineConfig } from "vite";
import path from "node:path";

export default defineConfig({
  // Relative base so the build works from a subpath on GitHub/Codeberg Pages.
  base: "./",
  build: {
    rollupOptions: {
      // lab.html is the Overlay Lab on its own, for sharing outside the app.
      input: { main: path.resolve(__dirname, "index.html"), lab: path.resolve(__dirname, "lab.html") },
    },
  },
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
      "@factoriotools/sim": path.resolve(__dirname, "../../packages/sim/src/index.ts"),
    },
  },
});
