// The landing site: static HTML only, served by app.ts from landing/dist at "/".
// See landing/README.md for the AEO rules every page follows.
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defineConfig } from "astro/config";
import { redirectLocation, redirectTable, validateRedirects } from "./src/lib/redirects.ts";

// chipp/redirects.json at the repo root: the site's 301/302 redirects. The
// Deno server serves them in production (src/lib/site-redirects.ts); the
// plugin below serves them in `astro dev`. A bad file fails the build here.
const REDIRECTS_FILE = fileURLToPath(new URL("../chipp/redirects.json", import.meta.url));

function loadRedirects() {
  if (!existsSync(REDIRECTS_FILE)) return [];
  let data;
  try {
    data = JSON.parse(readFileSync(REDIRECTS_FILE, "utf8"));
  } catch (err) {
    throw new Error(`[redirects] chipp/redirects.json does not parse: ${err.message}`);
  }
  const problems = validateRedirects(data);
  if (problems.length > 0) {
    throw new Error(`[redirects] chipp/redirects.json has ${problems.length} problem(s):\n  - ${problems.join("\n  - ")}`);
  }
  return data.redirects;
}

const redirects = loadRedirects();

/** Serve chipp/redirects.json in `astro dev`, the same way the server does. */
function devRedirects() {
  const table = redirectTable(redirects);
  return {
    name: "chipp-dev-redirects",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (req.method !== "GET" && req.method !== "HEAD") return next();
        const url = new URL(req.url ?? "/", "http://localhost");
        const key = url.pathname === "/" ? "/" : url.pathname.replace(/\/+$/, "");
        const rule = table.get(key);
        if (!rule) return next();
        res.statusCode = rule.status;
        res.setHeader("Location", redirectLocation(rule, url.search));
        res.end();
      });
    },
  };
}

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
  vite: { plugins: [devRedirects()] },
});
