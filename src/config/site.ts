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
 * every non-API path, so "/" keeps working too.
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
