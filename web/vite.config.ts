import { defineConfig } from "vite";
import { svelte } from "@sveltejs/vite-plugin-svelte";

// Project id for brand-loader.js. Baked at build time so the loader
// in index.html knows which project to fetch /brand.json for. The
// alchemist-customer build pipeline injects this via the
// ALCHEMIST_PROJECT_ID env var; local dev / template defaults to null
// and the loader falls back to template colors gracefully.
const PROJECT_ID = process.env.ALCHEMIST_PROJECT_ID
  ? JSON.stringify(process.env.ALCHEMIST_PROJECT_ID)
  : "null";

export default defineConfig({
  plugins: [svelte()],
  base: "/",
  define: {
    // Available in index.html via the inline script that wires
    // window.ALCHEMIST_PROJECT_ID. Surfaces as a string literal so
    // an unset value lands as JS `null` (not `undefined`).
    __ALCHEMIST_PROJECT_ID__: PROJECT_ID,
  },
  build: {
    outDir: "dist",
    sourcemap: false,
  },
  server: {
    port: 5273,
    proxy: {
      "/api": {
        target: "http://localhost:8300",
        changeOrigin: true,
      },
      "/auth": {
        target: "http://localhost:8300",
        changeOrigin: true,
      },
      "/health": {
        target: "http://localhost:8300",
        changeOrigin: true,
      },
    },
  },
});
