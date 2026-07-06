import Dashboard from "./routes/Dashboard.svelte";
import Login from "./routes/Login.svelte";
import Signup from "./routes/Signup.svelte";
import Settings from "./routes/Settings.svelte";
import Docs from "./routes/Docs.svelte";
import InboundEmails from "./routes/InboundEmails.svelte";
import InboundEmailDetail from "./routes/InboundEmailDetail.svelte";
import InviteAccept from "./routes/InviteAccept.svelte";
import NotFound from "./routes/NotFound.svelte";

// Type widened to `unknown` because Svelte 5's component types
// (especially for components using $props() like InviteAccept)
// don't unify under the older `ComponentType` brand. The Vite
// build is the load-bearing check; svelte-spa-router accepts
// any callable component reference at runtime.
// deno-lint-ignore no-explicit-any
const routes: Record<string, any> = {
  "/": Dashboard,
  "/login": Login,
  "/signup": Signup,
  "/settings": Settings,
  // In-app docs section with semantic search. /docs lists the TOC;
  // /docs/:slug deep-links to a page.
  "/docs": Docs,
  "/docs/:slug": Docs,
  // Inbound Email ops surface. Authed (not in the public route sets):
  // /inbound-emails lists captured emails; /inbound-emails/:id shows one.
  "/inbound-emails": InboundEmails,
  "/inbound-emails/:id": InboundEmailDetail,
  // Invite acceptance landing page. Token comes from the URL; the
  // page handles both logged-in and logged-out flows.
  "/invite/:token": InviteAccept,
  "*": NotFound,
};

/**
 * Routes that don't require authentication.
 *
 * Static literal paths get a Set lookup. Path-pattern routes
 * (anything with a :param) need a prefix match, since `$location`
 * from svelte-spa-router is the actual path (`/invite/abc123`),
 * not the pattern (`/invite/:token`). Use `isPublicRoute(path)` —
 * never read the Set directly.
 *
 * /invite/:token is unauthenticated because the preview
 * (GET /api/invite/:token) is intentionally callable by users who
 * land from an email link without a session yet. The acceptance
 * step itself is auth-gated server-side; the InviteAccept page
 * routes the user through /signup or /login first if they aren't
 * authenticated.
 */
const PUBLIC_LITERAL_ROUTES = new Set(["/login", "/signup"]);
const PUBLIC_PREFIX_ROUTES = ["/invite/"];

export function isPublicRoute(path: string): boolean {
  if (PUBLIC_LITERAL_ROUTES.has(path)) return true;
  return PUBLIC_PREFIX_ROUTES.some((prefix) => path.startsWith(prefix));
}

/** @deprecated Use `isPublicRoute(path)` instead. Kept as a Set
 *  shape for backward compat in components that read it directly. */
export const publicRoutes = PUBLIC_LITERAL_ROUTES;

export default routes;
