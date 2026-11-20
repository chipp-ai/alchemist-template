/**
 * The SPA fallback: the catch-all after every route, the landing site and
 * the static handler. It answers the SPA shell (web/dist/index.html) for a
 * path nothing else served, so a deep link into the app loads.
 *
 * It never answers HTML for a hashed build file. Vite emits `/assets/*` and
 * the landing build emits `/_astro/*`; their names change on every build.
 * During a rolling deploy the new pod's HTML names a new bundle, and a
 * request for it can reach an old pod that does not have the file. If that
 * pod answers the shell with 200, Cloudflare caches the HTML under the
 * bundle URL for hours and the app does not load for anyone (2026-10-19,
 * Valor Victoria). A missing hashed file is a 404 with `no-store`, so
 * nothing caches it and the next request reaches a pod that has the file.
 */

import type { Context, MiddlewareHandler, Next } from "hono";
import { serveStatic } from "hono/deno";

/** Path prefixes of hashed build output (Vite `assets`, Astro `_astro`). */
export const HASHED_ASSET_PREFIXES: readonly string[] = ["/assets/", "/_astro/"];

/** True for a path under a hashed build output prefix. */
export function isHashedAssetPath(path: string): boolean {
  return HASHED_ASSET_PREFIXES.some((prefix) => path.startsWith(prefix));
}

/** The answer for a hashed build file this pod does not have. */
export function hashedAssetMissResponse(c: Context): Response {
  c.header("Cache-Control", "no-store");
  return c.text("Not found", 404) as Response;
}

/** The catch-all SPA fallback middleware. `indexPath` is the built shell. */
export function spaFallbackMiddleware(indexPath = "./web/dist/index.html"): MiddlewareHandler {
  const serveShell = serveStatic({ path: indexPath });
  return async (c: Context, next: Next) => {
    // /api/* requests must NOT receive the SPA shell: they need to surface
    // real 4xx/5xx + JSON bodies to the SPA fetch caller.
    if (c.req.path.startsWith("/api/")) return next();
    if (isHashedAssetPath(c.req.path)) return hashedAssetMissResponse(c);
    // Marks the catch-all answer: no page exists at this path. The old-URL
    // gate (scripts/check-old-urls.ts) counts it as a missing page. "/" is
    // never missing: without a landing site it IS the app.
    if (c.req.path !== "/") c.header("X-Spa-Fallback", "1");
    return serveShell(c, next);
  };
}
