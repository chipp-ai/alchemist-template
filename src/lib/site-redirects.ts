/**
 * The site's 301/302 redirects: `chipp/redirects.json` at the repo root.
 *
 *   { "redirects": [ { "from": "/old", "to": "/new", "status": 301 } ] }
 *
 * A migrated site writes this file so old URLs keep working. The middleware
 * runs after every app route and the landing site, and before the SPA
 * fallback, so a redirect applies only when nothing else serves the path:
 * a real page always wins (the landing build fails when a rule would never
 * fire because a page exists at its `from`). `/api/*` is never redirected.
 *
 * The file is validated by the landing build (landing/astro.config.mjs) and
 * by the server tests, with the same rules (landing/src/lib/redirects.ts):
 * `from` starts with "/", status 301 or 302, no duplicates, no loops. If a
 * broken file still reaches a pod, the server logs an error and serves no
 * redirects rather than a loop. The file ships in the image (the runtime
 * stage copies the repo), so the server reads it once at boot.
 */

import type { MiddlewareHandler } from "hono";
import { log } from "@/lib/logger.ts";
import {
  redirectKey,
  redirectLocation,
  redirectTable,
  type SiteRedirect,
  validateRedirects,
} from "../../landing/src/lib/redirects.ts";

export const SITE_REDIRECTS_FILE = "./chipp/redirects.json";

/** Read and validate the file. Missing file: no redirects. Invalid: no redirects, logged. */
export function loadSiteRedirects(file: string = SITE_REDIRECTS_FILE): SiteRedirect[] {
  let text: string;
  try {
    text = Deno.readTextFileSync(file);
  } catch {
    return [];
  }
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (err) {
    log.error("chipp/redirects.json does not parse; serving no redirects", {
      source: "site-redirects",
      feature: "load",
    }, err instanceof Error ? err : new Error(String(err)));
    return [];
  }
  const problems = validateRedirects(data);
  if (problems.length > 0) {
    log.error("chipp/redirects.json is invalid; serving no redirects", {
      source: "site-redirects",
      feature: "load",
      problems: problems.slice(0, 10).join("; "),
    });
    return [];
  }
  return (data as { redirects: SiteRedirect[] }).redirects;
}

/** The middleware, or null when there are no redirects (nothing to mount). */
export function siteRedirectsMiddleware(rules: SiteRedirect[] = loadSiteRedirects()): MiddlewareHandler | null {
  if (rules.length === 0) return null;
  const table = redirectTable(rules);
  return async (c, next) => {
    const method = c.req.method;
    const path = c.req.path;
    if ((method !== "GET" && method !== "HEAD") || path === "/api" || path.startsWith("/api/")) return await next();
    const rule = table.get(redirectKey(path));
    if (!rule) return await next();
    const search = new URL(c.req.url).search;
    return c.redirect(redirectLocation(rule, search), rule.status);
  };
}
