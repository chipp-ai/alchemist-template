/**
 * Demo-mode noindex guard.
 *
 * Part of the shared DEMO_MODE contract: a live template demo must never
 * outrank a real customer's deployment in search results. When
 * `DEMO_MODE=1`, every response carries `X-Robots-Tag: noindex, nofollow`
 * and `GET /robots.txt` serves a disallow-all body. Both are complete
 * no-ops when DEMO_MODE is unset -- the header is never set and the
 * robots.txt route calls `next()` so it falls through to whatever would
 * have handled that path before this middleware existed (the SPA static
 * fallback), preserving the exact prior behavior byte-for-byte.
 */

import { createMiddleware } from "hono/factory";
import { isDemoMode } from "@/config/demo-mode.ts";

/** Sets `X-Robots-Tag: noindex, nofollow` on every response in demo mode. */
export const demoNoindexHeaderMiddleware = createMiddleware(async (c, next) => {
  await next();
  if (isDemoMode()) {
    c.header("X-Robots-Tag", "noindex, nofollow");
  }
});

/** `GET /robots.txt` -- disallow-all in demo mode, otherwise pass through. */
export const demoRobotsTxtRoute = createMiddleware(async (c, next) => {
  if (!isDemoMode()) return next();
  c.header("Content-Type", "text/plain; charset=utf-8");
  return c.text("User-agent: *\nDisallow: /\n");
});
