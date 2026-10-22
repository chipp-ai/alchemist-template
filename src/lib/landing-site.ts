/**
 * The landing site: the static Astro build in `landing/dist`, served at "/"
 * (2026-10-19). The signed-in SPA lives at `APP_BASE_PATH` (src/config/site.ts).
 *
 * Why a separate site: answer engines and crawlers read raw static HTML. The
 * SPA renders nothing until its JS runs, so product facts that live only in
 * the SPA are invisible to them. landing/ follows the AEO rules in
 * landing/README.md and its build fails on a broken rule (scripts/aeo-check.mjs).
 *
 * The middleware serves a file only when it exists in `landing/dist`. Every
 * other request falls through to the SPA exactly as before, so a checkout that
 * has not built landing/ (local dev, an older image) behaves like it did before
 * the landing site existed.
 *
 * App-first mode (2026-10-22): a product whose app IS the homepage sets
 * `"homepage": "app"` in `landing/src/content/site.json`. The server then
 * never mounts the landing site, so "/" serves the SPA shell (hash routes
 * work: "/#/settings") and "/app/..." keeps working for old links. Without
 * the field, or with any other value, the landing site owns "/" as before.
 * The file ships in the image (the runtime stage copies the repo), so the
 * server reads it at boot.
 */

import type { MiddlewareHandler } from "hono";
import { serveStatic } from "hono/deno";
import { APP_BASE_PATH } from "@/config/site.ts";
import { log } from "@/lib/logger.ts";

/** Where `npm run build` in landing/ writes the site, relative to the repo root. */
export const LANDING_DIST_DIR = "./landing/dist";

/** The landing copy file. Its optional `homepage` field picks the mode. */
export const LANDING_SITE_JSON = "./landing/src/content/site.json";

/** What "/" serves: the landing site (default) or the app. */
export type HomepageMode = "landing" | "app";

/**
 * Read `homepage` from site.json. "app" means app-first; a missing file or
 * field means "landing". An unknown value also means "landing", with a
 * warning, so a typo never takes the homepage away silently.
 */
export function readHomepageMode(file: string = LANDING_SITE_JSON): HomepageMode {
  let value: unknown;
  try {
    value = JSON.parse(Deno.readTextFileSync(file))?.homepage;
  } catch {
    return "landing";
  }
  if (value === "app") return "app";
  if (value !== undefined && value !== "landing") {
    log.warn('site.json "homepage" must be "landing" or "app"; serving the landing site', {
      source: "landing-site",
      feature: "homepage-mode",
      value: String(value),
    });
  }
  return "landing";
}

/** True when the landing site is built: `<dir>/index.html` exists. */
export function landingSiteBuilt(dir: string = LANDING_DIST_DIR): boolean {
  try {
    return Deno.statSync(`${dir}/index.html`).isFile;
  } catch {
    return false;
  }
}

/**
 * Paths the landing site never answers. `/api/*` keeps its JSON errors,
 * `/index.html` stays the SPA shell (the demo landing links to it), and the
 * SPA prefix belongs to the SPA.
 */
export function isLandingPath(path: string): boolean {
  if (path.startsWith("/api/") || path === "/api") return false;
  if (path === "/index.html") return false;
  if (APP_BASE_PATH && (path === APP_BASE_PATH || path.startsWith(`${APP_BASE_PATH}/`))) {
    return false;
  }
  return true;
}

/**
 * The landing site middleware, or null when `landing/dist` is not built or
 * the project is app-first. Checked once at boot: neither can change in a
 * running pod. With null, "/" falls through to the SPA shell in app.ts.
 */
export function landingSiteMiddleware(
  dir: string = LANDING_DIST_DIR,
  mode: HomepageMode = readHomepageMode(),
): MiddlewareHandler | null {
  if (mode === "app") return null;
  if (!landingSiteBuilt(dir)) return null;
  const serve = serveStatic({ root: dir });
  return async (c, next) => {
    if (!isLandingPath(c.req.path)) return await next();
    return await serve(c, next);
  };
}
