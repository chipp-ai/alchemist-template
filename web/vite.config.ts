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
    // E2B exposes Vite over a public subdomain like
    // `5173-<sandbox-id>.e2b.app` when the user opens a scratch
    // workspace from the alchemist dashboard. Vite 5+ rejects unknown
    // Hosts by default (DNS-rebinding protection); whitelist all
    // e2b.app subdomains so the Live-preview link in app.adaas.dev
    // resolves. Adds .localhost / .local for parity with developer
    // laptops and any future tunnel.
    allowedHosts: [".e2b.app", ".localhost", ".local"],
    proxy: (() => {
      // VITE_API_PROXY lets the embedding harness override where the
      // SPA proxies /api + /auth + /health. The Alchemist Mac desktop
      // app sets it (the customer template's API binds :8100 there
      // to coexist with the alchemist-ai controller on :8000). The
      // sandbox / E2B path doesn't set it; default to :8000 so the
      // cloud agent flow is unchanged.
      const target = process.env.VITE_API_PROXY || "http://localhost:8000";
      return {
        "/api": {
          target,
          changeOrigin: true,
          ws: true,
        },
        "/auth": {
          target,
          changeOrigin: true,
        },
        "/health": {
          target,
          changeOrigin: true,
        },
      };
    })(),
  },
});
