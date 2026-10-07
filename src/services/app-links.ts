/**
 * The app's public origin. Part of the SSR kernel (`.claude/rules/ssr.md`).
 *
 * `APP_URL` is the one source for absolute links: canonical URLs, JSON-LD,
 * sitemaps, Stripe return URLs, email links. Never build an absolute link
 * from the request host: behind the edge proxy it can be the pod's
 * internal host.
 */

import { getEnv } from "@/lib/env.ts";

const DEV_ORIGIN = "http://localhost:8000";

/** `APP_URL` with no trailing slash, or the local dev origin when unset. */
export function appOrigin(): string {
  let raw: string | undefined;
  try {
    raw = getEnv("APP_URL");
  } catch {
    // No env permission (a sandboxed script): fall back like an unset var.
    raw = undefined;
  }
  return originFrom(raw);
}

/** The origin for a raw `APP_URL` value. Pure: exported for tests. */
export function originFrom(raw: string | undefined): string {
  const value = raw?.trim();
  return (value ? value : DEV_ORIGIN).replace(/\/+$/, "");
}
