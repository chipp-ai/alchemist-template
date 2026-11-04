/**
 * One-click unsubscribe links (RFC 8058).
 *
 * Every ordinary (non-auth-critical) message carries
 *
 *   List-Unsubscribe: <https://<app>/api/unsubscribe/<token>>[, <mailto:...>]
 *   List-Unsubscribe-Post: List-Unsubscribe=One-Click
 *
 * and a campaign also puts the same https link in its footer. The mailbox
 * provider POSTs `List-Unsubscribe=One-Click` to the URL when a person hits
 * "Unsubscribe" in the mail client; that POST is the whole unsubscribe, no
 * sign-in, no confirmation page. A GET (a person clicking the footer link,
 * or a link scanner prefetching it) only shows a page with a button that
 * POSTs, so a prefetch can never unsubscribe anyone.
 *
 * The token is the credential: `base64url(payload).base64url(hmac)`, where
 * the payload is `v1|<organizationId or empty>|<email>`. HMAC-SHA256 with
 * `EMAIL_UNSUBSCRIBE_SECRET`, falling back to `JWT_SECRET`. It never
 * expires, because an unsubscribe link in a two-year-old email must still
 * work. It can only ever unsubscribe the address it names.
 *
 * Synchronous (node:crypto) on purpose: the transport builds headers in a
 * sync function, and a per-send await for a MAC would be noise.
 */

import { createHmac, timingSafeEqual } from "node:crypto";
import { Buffer } from "node:buffer";
import { getEnv } from "@/lib/env.ts";
import { appOrigin } from "@/services/app-links.ts";

const VERSION = "v1";
/** Where the one-click endpoint is mounted (src/api/routes/unsubscribe). */
export const UNSUBSCRIBE_PATH = "/api/unsubscribe";

/**
 * Optional mailto target for List-Unsubscribe. Set it ONLY when something
 * actually processes mail sent to that address (the platform routes it to
 * the feedback endpoint). Advertising a mailbox nobody reads is worse than
 * none: the person thinks they unsubscribed and keeps getting mail.
 */
export const UNSUBSCRIBE_MAILTO_ENV = "EMAIL_UNSUBSCRIBE_MAILTO";

function readEnv(key: string): string | undefined {
  try {
    return getEnv(key);
  } catch {
    return undefined;
  }
}

function secret(): string {
  return readEnv("EMAIL_UNSUBSCRIBE_SECRET") || readEnv("JWT_SECRET") || "development-secret";
}

function b64url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64url");
}

function mac(payload: string): Buffer {
  return createHmac("sha256", secret()).update(payload).digest();
}

export interface UnsubscribeTarget {
  email: string;
  /** The workspace whose mail this was. NULL = not tied to one. */
  organizationId: string | null;
}

export function signUnsubscribeToken(target: UnsubscribeTarget): string {
  const payload = `${VERSION}|${target.organizationId ?? ""}|${target.email.trim().toLowerCase()}`;
  return `${b64url(payload)}.${b64url(mac(payload))}`;
}

/** The target, or null for anything forged, truncated or malformed. */
export function verifyUnsubscribeToken(token: string): UnsubscribeTarget | null {
  if (typeof token !== "string" || token.length > 2048) return null;
  const dot = token.indexOf(".");
  if (dot <= 0 || dot !== token.lastIndexOf(".")) return null;
  let payload: string;
  let presented: Buffer;
  try {
    payload = Buffer.from(token.slice(0, dot), "base64url").toString("utf8");
    presented = Buffer.from(token.slice(dot + 1), "base64url");
  } catch {
    return null;
  }
  const expected = mac(payload);
  if (presented.length !== expected.length || !timingSafeEqual(presented, expected)) return null;

  const parts = payload.split("|");
  if (parts.length !== 3 || parts[0] !== VERSION) return null;
  const [, org, email] = parts;
  if (!email || !email.includes("@")) return null;
  return { email, organizationId: org || null };
}

/** The https one-click URL for this recipient. */
export function unsubscribeUrl(target: UnsubscribeTarget): string {
  return `${appOrigin()}${UNSUBSCRIBE_PATH}/${signUnsubscribeToken(target)}`;
}

/**
 * The two headers, ready to merge. The mailto is included only when
 * `EMAIL_UNSUBSCRIBE_MAILTO` names an address something processes.
 */
export function oneClickUnsubscribeHeaders(target: UnsubscribeTarget): Record<string, string> {
  const parts = [`<${unsubscribeUrl(target)}>`];
  const mailto = readEnv(UNSUBSCRIBE_MAILTO_ENV)?.trim();
  if (mailto && /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(mailto)) {
    parts.push(`<mailto:${mailto}?subject=unsubscribe>`);
  }
  return {
    "List-Unsubscribe": parts.join(", "),
    "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
  };
}
