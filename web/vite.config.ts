import { defineConfig } from "vite";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import { fileURLToPath, URL } from "node:url";

// Project id for brand-loader.js. Baked at build time so the loader
// in index.html knows which project to fetch /brand.json for. The
// alchemist-customer build pipeline injects this via the
// ALCHEMIST_PROJECT_ID env var; local dev / template defaults to null
// and the loader falls back to template colors gracefully.
const PROJECT_ID = process.env.ALCHEMIST_PROJECT_ID
  ? JSON.stringify(process.env.ALCHEMIST_PROJECT_ID)
  : "null";

export default defineConfig({
  plugins: [
    svelte(),
    {
      // vite's `define` substitutes tokens in the JS module graph but
      // NOT inside index.html's inline <script>, so the brand-loader's
      // `window.ALCHEMIST_PROJECT_ID = __ALCHEMIST_PROJECT_ID__` stayed
      // the literal token → resolved to null → branding never rendered
      // even when ALCHEMIST_PROJECT_ID was set at build. Replace the
      // token directly in the HTML at build time. PROJECT_ID is already
      // a JS literal ("<id>" or null).
      name: "inject-alchemist-project-id",
      transformIndexHtml(html: string) {
        return html.replaceAll("__ALCHEMIST_PROJECT_ID__", PROJECT_ID);
      },
    },
  ],
  base: "/",
  resolve: {
    // SvelteKit-style `$lib` alias. The template uses plain Vite (not
    // SvelteKit) but code + docstrings reference `$lib/...` imports
    // (e.g. NotFound.svelte → $lib/observability/breadcrumbs, added in
    // 4556376, and the devpanel store's usage example). Without this
    // alias `vite build` fails to resolve them and the customer deploy
    // breaks. Points at web/src/lib.
    alias: {
      $lib: fileURLToPath(new URL("./src/lib", import.meta.url)),
    },
  },
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
    // Hot reload through Chipp's AUTHENTICATED preview proxy.
    //
    // The gated preview serves this dev server from
    // `<previewId>.preview.chipp.ai` (Cloudflare Worker -> the sandbox's
    // e2b.app host, injecting E2B's traffic token). Vite computes the HMR
    // WebSocket URL in the BROWSER from the constants it injects at serve
    // time, so with no override the client dials
    // `wss://<previewId>.preview.chipp.ai:5173/`. Cloudflare only proxies
    // HTTPS on 443/2053/2083/2087/2096/8443 -- 5173 is not one of them, so
    // the socket never connects and the preview goes stale-on-edit. This
    // cannot be fixed at the proxy; the port has to come from here.
    //
    // Env-gated because hardcoding it breaks plain `http://localhost:5173`
    // dev, where there is no TLS and no 443. The platform sets
    // VITE_HMR_PUBLIC=1 when it boots the dev server behind the proxy.
    ...(process.env.VITE_HMR_PUBLIC
      ? { hmr: { protocol: "wss" as const, clientPort: 443 } }
      : {}),
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
