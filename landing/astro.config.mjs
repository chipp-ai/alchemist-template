// The landing site: static HTML only, served by app.ts from landing/dist at "/".
// See landing/README.md for the AEO rules every page follows.
import { defineConfig } from "astro/config";

export default defineConfig({
  output: "static",
  outDir: "./dist",
  build: {
    // /pricing/index.html, so /pricing and /pricing/ both resolve.
    format: "directory",
  },
  // Key facts live in the HTML, not in client JS.
  prefetch: false,
  devToolbar: { enabled: false },
});
