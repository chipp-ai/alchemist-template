/**
 * Where the signed-in SPA lives. Part of the SSR kernel
 * (`.claude/rules/ssr.md`).
 *
 * Server-rendered pages and config link into the SPA with `appPath()`,
 * never with a hard-coded "/#/..." string. Today the SPA is served at the
 * site root, so `appPath("/#/login")` is "/#/login". A recipe that puts a
 * public page at "/" serves the SPA at a prefix as well (for example
 * `/admin`) and forwards "/#/..." there, so root links keep working. If a
 * project ever drops the root SPA route, change `APP_BASE_PATH` here and
 * every link follows.
 */

/** The SPA's path prefix, with no trailing slash ("" = the site root). */
export const APP_BASE_PATH = "";

/** A link into the SPA. `path` starts with "/" (for example "/#/settings"). */
export function appPath(path: string): string {
  if (!path.startsWith("/")) {
    throw new Error(`appPath: "${path}" must start with "/"`);
  }
  return `${APP_BASE_PATH}${path}`;
}
