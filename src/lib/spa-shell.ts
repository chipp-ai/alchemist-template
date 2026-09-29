/**
 * The built SPA shell (`web/dist/index.html`) served from a route. Part of
 * the SSR kernel (`.claude/rules/ssr.md`).
 *
 * By default `app.ts` serves the SPA at every non-API path. When a recipe
 * puts a server-rendered page at "/", the SPA moves to a prefix such as
 * `/admin`, and that route calls `serveSpaShell`. Vite `base` stays "/", so
 * the shell's `/assets/...` URLs still resolve through the static handler.
 * Hash routes work unchanged: `/admin#/settings`.
 *
 * The file is read once per process (it cannot change in a running pod).
 * A missing file, a checkout that has not run the web build, is a 404, not
 * a crash. The global middleware in app.ts (Chipp Insights beacon, DEMO_MODE
 * banner) still rewrites this HTML like any other HTML response.
 */

import type { Context } from "hono";

// `undefined` = not read yet; `null` = read, and the file is missing.
let cachedShellHtml: string | null | undefined;
let spaIndexPathOverride: string | URL | null = null;

function spaIndexPath(): string | URL {
  return spaIndexPathOverride ?? new URL("../../web/dist/index.html", import.meta.url);
}

/** The built SPA shell HTML, or null when `web/dist/index.html` is not built. */
export function renderSpaShellHtml(): string | null {
  if (cachedShellHtml !== undefined) return cachedShellHtml;
  try {
    cachedShellHtml = Deno.readTextFileSync(spaIndexPath());
  } catch {
    cachedShellHtml = null;
  }
  return cachedShellHtml;
}

/** Hono handler: the SPA shell, or a 404 when it is not built. */
export function serveSpaShell(c: Context): Response {
  const html = renderSpaShellHtml();
  return html === null ? c.notFound() as Response : c.html(html) as Response;
}

/** Test seam: read the shell from `path` (null restores the real one) and clear the cache. */
export function __setSpaIndexPathForTests(path: string | URL | null): void {
  spaIndexPathOverride = path;
  cachedShellHtml = undefined;
}
