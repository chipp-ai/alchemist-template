/**
 * Route access: every API route requires a signed-in user unless it is
 * marked public with a reason.
 *
 * WHY (2026-11-26). A scan of 159,041 live Lovable apps found about 30% leaked
 * their users' email addresses. Apps built on this template never give the
 * browser a database key, but a coding agent still writes each app's API
 * routes, and one GET route without `requireAuth` leaks the same way. So the
 * default is now the safe one: a NEW route under /api/ is behind sign-in even
 * when its author forgot `requireAuth`.
 *
 * HOW. `apiAuthByDefault` is mounted in app.ts on `/api/*`, before every
 * route. For a request it:
 *   1. lets through the template's own API surfaces (`TEMPLATE_API_PREFIXES`):
 *      each of those routers runs its own check (session, bearer token, HMAC,
 *      signed URL, invite or portal token), and several are public by design
 *      (sign-in, the invite preview, webhooks);
 *   2. lets through a route registered with `publicRoute("<reason>")`;
 *   3. lets a path no route matches fall through to the 404;
 *   4. otherwise runs `requireAuth` (401 without a valid session).
 * `requireAuth` skips its work when a user is already on the context, so a
 * route that also lists `requireAuth` is not verified twice.
 *
 * A PUBLIC route (a contact form, a public listing):
 *
 *   leadsRoutes.post("/", publicRoute("contact form on the marketing site"), handler);
 *
 * It must return no personal fields (emails, phones, addresses, names with
 * ids, tokens). `deno task conformance` checks both rules before you push,
 * and Chipp's build runs the same check on every publish: an API route that
 * touches data with no auth and no `publicRoute(...)` does not deploy. Chipp
 * also probes every live app without signing in and tells the owner when a
 * route returns personal records.
 *
 * Note: a route registered with `.all(...)` is not seen as a route here (Hono
 * records it like middleware), so it relies on its own `requireAuth`.
 */

import { createMiddleware } from "hono/factory";
import type { MiddlewareHandler } from "hono";
import { requireAuth } from "./auth.ts";

/** Marker middlewares created by publicRoute(). Identity, not name, decides. */
const PUBLIC_MARKERS = new WeakSet<object>();

/** Hono wraps a sub-app handler when the sub-app has its own onError; the original sits here. */
const COMPOSED_HANDLER = "__COMPOSED_HANDLER";

/**
 * Mark one route as callable by anyone. The reason is required: say who
 * calls it and why it cannot require sign-in.
 */
export function publicRoute(reason: string): MiddlewareHandler {
  if (typeof reason !== "string" || reason.trim().length === 0) {
    throw new Error("publicRoute(reason): say why anyone on the internet may call this route");
  }
  const marker: MiddlewareHandler = async (_c, next) => {
    await next();
  };
  PUBLIC_MARKERS.add(marker);
  return marker;
}

/**
 * The template's own API surfaces. Each router under these prefixes does its
 * own authentication (or is public by design and reviewed in this repo), so
 * the default does not apply to them. Keep this list to template and Chipp
 * pack routers; an app's own routes never go here (use publicRoute instead).
 */
export const TEMPLATE_API_PREFIXES: readonly string[] = [
  "/api/auth",
  "/api/org",
  "/api/billing",
  "/api/chipp-payments",
  "/api/docs",
  "/api/files",
  "/api/storage/local",
  "/api/imports",
  "/api/invite",
  "/api/ingest/email",
  "/api/events",
  "/api/inbound-emails",
  "/api/email",
  "/api/portal",
  "/api/agent-mcp",
  "/api/realtime",
  "/api/dev",
  "/api/_observability",
  "/api/api-keys",
  "/api/v1",
  "/api/mcp",
  "/api/dashboard/command-center",
  "/api/tickets-and-billing",
  "/api/support",
  "/api/embedded-agent",
  "/api/assistants",
  // Chipp packs mounted at the site root (cms, landing page, storefront).
  "/api/cms",
  "/api/leads",
  "/api/catalog",
  "/api/client",
  "/api/__catalog_probe",
  "/api/internal",
  // Older template versions.
  "/api/site-forms",
  "/api/unsubscribe",
  "/api/mailing",
  "/api/email-feedback",
  "/api/platform",
];

export function isTemplateApiPath(path: string): boolean {
  return TEMPLATE_API_PREFIXES.some((p) => path === p || path.startsWith(`${p}/`));
}

function isPublicMarker(handler: unknown): boolean {
  if (!handler || (typeof handler !== "function" && typeof handler !== "object")) return false;
  if (PUBLIC_MARKERS.has(handler as object)) return true;
  const inner = (handler as Record<string, unknown>)[COMPOSED_HANDLER];
  return !!inner && typeof inner === "function" && PUBLIC_MARKERS.has(inner);
}

/** Mounted in app.ts on "/api/*" before every route. See the header. */
export const apiAuthByDefault = createMiddleware(async (c, next) => {
  const path = c.req.path;
  if (!path.startsWith("/api/") || isTemplateApiPath(path)) return await next();
  // matchedRoutes(c) from hono/route needs a newer Hono than some projects pin
  const matched = c.req.matchedRoutes;
  if (matched.some((r) => isPublicMarker(r.handler))) return await next();
  // Only middleware matched (method "ALL"): no route serves this path, let it 404.
  if (!matched.some((r) => r.method !== "ALL")) return await next();
  return await requireAuth(c, next);
});
