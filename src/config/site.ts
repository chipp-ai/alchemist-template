/**
 * Where the signed-in SPA lives. Part of the SSR kernel
 * (`.claude/rules/ssr.md`).
 *
 * Server-rendered pages, emails and config link into the SPA with
 * `appPath()`, never with a hard-coded "/#/..." string.
 *
 * The SPA lives at `/app` (2026-10-19). "/" belongs to the landing site in
 * `landing/` (a static Astro build, see landing/README.md), so
 * `appPath("/#/login")` is "/app/#/login". The landing pages forward old
 * "/#/..." links to "/app/#/...", so links sent before the move keep
 * working. When `landing/dist` is not built, app.ts still serves the SPA at
 * every non-API path, so "/" keeps working too. An app-first project sets
 * `"homepage": "app"` in landing/src/content/site.json and the SPA is served
 * at "/" as well (src/lib/landing-site.ts).
 *
 * Vite `base` stays "/": the shell's `/assets/...` URLs resolve through the
 * static handler at any prefix. Change `APP_BASE_PATH` here and every link
 * follows.
 */

/** The SPA's path prefix, with no trailing slash ("" = the site root). */
export const APP_BASE_PATH = "/app";

/** A link into the SPA. `path` starts with "/" (for example "/#/settings"). */
export function appPath(path: string): string {
  if (!path.startsWith("/")) {
    throw new Error(`appPath: "${path}" must start with "/"`);
  }
  return `${APP_BASE_PATH}${path}`;
}

/**
 * Pages a sign-in never returns to: the sign-in pages themselves, and "/",
 * which is already where a sign-in lands when nothing else was asked for.
 */
const NOT_RETURN_ROUTES = new Set(["/", "/login", "/signup"]);

/**
 * A SPA hash route ("/settings", "/docs/intro?tab=a") a sign-in may send the
 * person back to, or null. Used for the page someone asked for before they
 * were sent to sign in (OAuth `next`). Same rule as web/src/lib/return-to.ts:
 * starts with one "/", no backslash, no control character, no scheme, at
 * most 512 characters, never a sign-in page.
 */
export function safeAppRoute(route: string | undefined | null): string | null {
  if (!route) return null;
  const v = route.trim();
  if (v.length === 0 || v.length > 512) return null;
  if (!v.startsWith("/") || v.startsWith("//")) return null;
  if (/[\\\s\u0000-\u001f\u007f]/.test(v)) return null;
  if (/^\/+[a-z][a-z0-9+.-]*:/i.test(v)) return null;
  const bare = v.split(/[?#]/, 1)[0].replace(/\/+$/, "") || "/";
  if (NOT_RETURN_ROUTES.has(bare)) return null;
  return v;
}
