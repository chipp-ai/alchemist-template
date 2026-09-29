/**
 * The app's public origin. Part of the SSR kernel (`.claude/rules/ssr.md`).
 *
 * `APP_URL` is the one source for absolute links: canonical URLs, JSON-LD,
 * sitemaps, Stripe return URLs, email links. Never build an absolute link
 * from the request host: behind the edge proxy it can be the pod's
 * internal host.
 */

const DEV_ORIGIN = "http://localhost:8000";

/** `APP_URL` with no trailing slash, or the local dev origin when unset. */
export function appOrigin(): string {
  let raw: string | undefined;
  try {
    raw = Deno.env.get("APP_URL");
  } catch {
    // No env permission (a sandboxed script): fall back like an unset var.
    raw = undefined;
  }
  const value = raw?.trim();
  return (value ? value : DEV_ORIGIN).replace(/\/+$/, "");
}
