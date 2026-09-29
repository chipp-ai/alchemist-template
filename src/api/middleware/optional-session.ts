/**
 * The viewer of a public server-rendered page. Part of the SSR kernel
 * (`.claude/rules/ssr.md`).
 *
 * `optionalSession` never throws and never blocks. It sets `SsrSession`:
 *
 * - `user`: the signed-in user (same verify path as `requireAuth`), or null
 *   for an anonymous visitor or a crawler.
 * - `visitorId`: a stable anonymous id from the `visitor_id` cookie (random
 *   UUID, httpOnly, one year). The first request, or a request whose cookie
 *   is not a UUID, gets a fresh id and a Set-Cookie.
 *
 * Read it with `getSsrSession(c)`. Mount it path-scoped on the routes that
 * need it (`router.use("/products/*", optionalSession)`), never with
 * `use("*")` on a router mounted at "/": that would run it, and mint a
 * cookie, for every request the router sees.
 *
 * The session personalizes. It does not authorize. A route that writes
 * data or shows private records uses `requireAuth`.
 */

import { createMiddleware } from "hono/factory";
import { getCookie, setCookie } from "hono/cookie";
import { type AuthUser, resolveOptionalUser } from "./auth.ts";
import { log } from "@/lib/logger.ts";

export interface SsrSession {
  /** The signed-in user, or null for an anonymous visitor. */
  user: AuthUser | null;
  /** Stable anonymous id. Always present once the middleware ran. */
  visitorId: string;
}

/** Hono `Variables` for a router that uses `optionalSession`. */
export type SsrSessionVariables = { ssrSession: SsrSession };

export const VISITOR_COOKIE = "visitor_id";
const VISITOR_COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 365;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isProduction(): boolean {
  return Deno.env.get("NODE_ENV") === "production";
}

export const optionalSession = createMiddleware<{ Variables: SsrSessionVariables }>(
  async (c, next) => {
    let user: AuthUser | null = null;
    try {
      user = await resolveOptionalUser(c);
    } catch (err) {
      // resolveOptionalUser already degrades to null; this is defense in
      // depth for the "never throws" contract, and a surprise worth seeing.
      log.error("optionalSession: resolving the user threw", {
        source: "ssr",
        feature: "optional-session",
      }, err);
    }

    let visitorId = getCookie(c, VISITOR_COOKIE);
    if (!visitorId || !UUID_RE.test(visitorId)) {
      visitorId = crypto.randomUUID();
      setCookie(c, VISITOR_COOKIE, visitorId, {
        httpOnly: true,
        sameSite: "Lax",
        maxAge: VISITOR_COOKIE_MAX_AGE_SECONDS,
        path: "/",
        secure: isProduction(),
      });
    }

    c.set("ssrSession", { user, visitorId });
    await next();
  },
);

/**
 * The `SsrSession` set by `optionalSession`. Throws when the middleware did
 * not run on this route: that is a wiring bug, not a visitor state.
 */
export function getSsrSession(c: { get: (key: string) => unknown }): SsrSession {
  const session = c.get("ssrSession") as SsrSession | undefined;
  if (!session) {
    throw new Error("getSsrSession: optionalSession is not mounted on this route");
  }
  return session;
}
