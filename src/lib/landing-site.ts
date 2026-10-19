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
 */

import type { MiddlewareHandler } from "hono";
import { serveStatic } from "hono/deno";
import { APP_BASE_PATH } from "@/config/site.ts";

/** Where `npm run build` in landing/ writes the site, relative to the repo root. */
export const LANDING_DIST_DIR = "./landing/dist";

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
 * The landing site middleware, or null when `landing/dist` is not built.
 * Checked once at boot: the build output cannot change in a running pod.
 */
export function landingSiteMiddleware(dir: string = LANDING_DIST_DIR): MiddlewareHandler | null {
  if (!landingSiteBuilt(dir)) return null;
  const serve = serveStatic({ root: dir });
  return async (c, next) => {
    if (!isLandingPath(c.req.path)) return await next();
    return await serve(c, next);
  };
}
