/**
 * The app's public origin. Part of the SSR kernel (`.claude/rules/ssr.md`).
 *
 * `APP_URL` is the one source for absolute links: canonical URLs, JSON-LD,
 * sitemaps, email links. Never build an absolute link from the raw request
 * host: behind the edge proxy it can be the pod's internal host.
 *
 * One exception, for a browser round trip (OAuth redirect_uri and landing,
 * Stripe return URLs). An app can answer on its `<id>.on.chipp.ai` address
 * and a connected custom domain. The platform sets APP_URL to the canonical
 * one and lists every host in `ALCHEMIST_PUBLIC_HOSTS`. Session and OAuth
 * state cookies are host-only, so a round trip must come back to the host it
 * started on, or the user lands signed out (or OAuth fails its state check).
 * `requestAppOrigin()` / `requestWebOrigin()` use the request's host when it
 * is in that list, and fall back to APP_URL / WEB_APP_URL otherwise (always,
 * in local dev).
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
export function originFrom(raw: string | undefined, fallback = DEV_ORIGIN): string {
  const value = raw?.trim();
  return (value ? value : fallback).replace(/\/+$/, "");
}

const DEV_WEB_ORIGIN = "http://localhost:5173";

function readEnv(key: string): string | undefined {
  try {
    return getEnv(key);
  } catch {
    return undefined;
  }
}

/** `WEB_APP_URL` (where the browser loads the SPA) with no trailing slash. */
export function webAppOrigin(): string {
  return originFrom(readEnv("WEB_APP_URL"), DEV_WEB_ORIGIN);
}

/** Reads one request header (Hono's `c.req` fits). */
export interface RequestHeaders {
  header(name: string): string | undefined;
}

function normalizeHost(raw: string): string {
  return raw.trim().toLowerCase().replace(/:\d+$/, "").replace(/\.+$/, "");
}

/** The hosts the platform says this app serves (`ALCHEMIST_PUBLIC_HOSTS`). Empty in local dev. */
export function publicHosts(): string[] {
  return (readEnv("ALCHEMIST_PUBLIC_HOSTS") ?? "")
    .split(",")
    .map(normalizeHost)
    .filter((h) => h !== "");
}

/**
 * `https://<host>` for the host the request arrived on, when it is one of
 * `publicHosts()`. Null otherwise. Reads X-Forwarded-Host first (the Chipp
 * edge sets it to the inbound host and overwrites any client value), then
 * Host. A spoofed header can only name another host of this same app.
 */
export function requestPublicOrigin(req: RequestHeaders): string | null {
  const allowed = publicHosts();
  if (allowed.length === 0) return null;
  for (const name of ["x-forwarded-host", "host"]) {
    const raw = req.header(name)?.split(",")[0];
    if (!raw) continue;
    const host = normalizeHost(raw);
    if (allowed.includes(host)) return `https://${host}`;
  }
  return null;
}

/** The request's own public origin, else `appOrigin()`. For OAuth callbacks. */
export function requestAppOrigin(req: RequestHeaders): string {
  return requestPublicOrigin(req) ?? appOrigin();
}

/** The request's own public origin, else `webAppOrigin()`. For OAuth landings and Stripe returns. */
export function requestWebOrigin(req: RequestHeaders): string {
  return requestPublicOrigin(req) ?? webAppOrigin();
}
