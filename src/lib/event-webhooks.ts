/**
 * Outbound webhooks: a subscription of kind 'webhook' is a handler whose
 * body is "POST the event to this URL, signed". It rides the same claim,
 * retry, dead-letter and replay path as a code-declared handler
 * (src/lib/events.ts processDelivery dispatches on `kind`).
 *
 * WHAT A RECEIVER SEES
 *
 *   POST <url>
 *   Content-Type: application/json
 *   X-Event-Id: <event id>            de-duplicate on this
 *   X-Event-Topic: order.created
 *   X-Event-Timestamp: <unix seconds>
 *   X-Event-Signature: v1=<hex>       HMAC-SHA256(secret, `${ts}.${body}`)
 *   X-Event-Delivery: <delivery id>
 *   X-Event-Attempt: <n>
 *
 *   { "id", "topic", "key", "payload", "source", "createdAt" }
 *
 * Any 2xx is success. Anything else, a timeout, or a redirect (followed
 * redirects could land on an internal address) is a failed attempt.
 * At-least-once: a pod that dies after the POST but before the status
 * write re-sends after the stale-claim reaper; receivers must treat
 * X-Event-Id as the idempotency key.
 *
 * THE SECRET IS NOT IN THE DATABASE. `secret_ref` names an environment
 * variable that holds it. This repo has no encryption-at-rest helper
 * for secrets, and inventing one here would be worse than a reference:
 * the platform already delivers per-project env vars as Kubernetes
 * secrets. A builder creating a webhook picks a name, the operator sets
 * the variable, and the row only ever points at it.
 *
 * URL VALIDATION is here and not a shared helper because this repo had
 * none. https only, no credentials in the URL, no literal private,
 * loopback, link-local, multicast or unspecified address, no local
 * hostnames. It is checked when the subscription is created AND again
 * at every delivery, so an edited row cannot bypass it. It does not
 * resolve DNS: a public hostname that resolves to a private address at
 * delivery time (DNS rebinding) is not caught, because fetch() gives no
 * way to pin the address it connects to.
 */

import { db } from "@/db/client.ts";
import type { EventSubscriptionRow } from "@/db/schema.ts";
import {
  EVENT_ID_HEADER,
  EVENT_SIGNATURE_HEADER,
  EVENT_TIMESTAMP_HEADER,
  EVENT_TOPIC_HEADER,
  signEventBody,
} from "@/lib/event-signing.ts";
import type { ClaimedDelivery } from "@/lib/events.ts";
import { BadRequestError, NotFoundError } from "@/utils/errors.ts";

export const EVENT_DELIVERY_HEADER = "X-Event-Delivery";
export const EVENT_ATTEMPT_HEADER = "X-Event-Attempt";

/** Bound on one webhook POST (connect + response headers). */
export const DEFAULT_WEBHOOK_TIMEOUT_MS = 10_000;

/** Same shape rule as registerEventHandler: `noun.past_tense`. */
const TOPIC_PATTERN = /^[a-z0-9_]+(\.[a-z0-9_]+)+$/;
/** An env var name: what `secret_ref` is allowed to hold. */
const SECRET_REF_PATTERN = /^[A-Z][A-Z0-9_]{2,127}$/;

// ── URL validation ──

const BLOCKED_HOSTNAMES = new Set(["localhost", "localhost.localdomain", "broadcasthost"]);
const BLOCKED_HOST_SUFFIXES = [".localhost", ".local", ".internal", ".home.arpa"];

function parseIpv4(host: string): number[] | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return null;
  const parts = m.slice(1).map(Number);
  return parts.every((p) => p <= 255) ? parts : null;
}

function isBlockedIpv4(parts: number[]): boolean {
  const [a, b] = parts;
  if (a === 0) return true; // 0.0.0.0/8 unspecified / "this network"
  if (a === 10) return true; // 10/8 private
  if (a === 127) return true; // loopback
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64/10 carrier NAT
  if (a === 169 && b === 254) return true; // link-local, cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16/12 private
  if (a === 192 && b === 168) return true; // 192.168/16 private
  if (a === 192 && b === 0 && parts[2] === 0) return true; // 192.0.0/24 IETF
  if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking
  if (a >= 224) return true; // multicast + reserved + broadcast
  return false;
}

/** Expand an IPv6 literal to its 8 hextets, or null when malformed. */
function parseIpv6(host: string): number[] | null {
  const zoneStripped = host.split("%")[0];
  // An IPv4-mapped tail (::ffff:10.0.0.1) is turned into two hextets.
  const v4tail = /^(.*:)(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(zoneStripped);
  let text = zoneStripped;
  if (v4tail) {
    const v4 = parseIpv4(v4tail[2]);
    if (!v4) return null;
    text = `${v4tail[1]}${((v4[0] << 8) | v4[1]).toString(16)}:${
      ((v4[2] << 8) | v4[3]).toString(16)
    }`;
  }
  const halves = text.split("::");
  if (halves.length > 2) return null;
  const toHextets = (s: string) => (s.length === 0 ? [] : s.split(":"));
  const head = toHextets(halves[0]);
  const tail = halves.length === 2 ? toHextets(halves[1]) : [];
  const missing = 8 - head.length - tail.length;
  if (halves.length === 2 ? missing < 1 : missing !== 0) return null;
  const all = [...head, ...(halves.length === 2 ? Array(missing).fill("0") : []), ...tail];
  const parsed = all.map((h) => (/^[0-9a-f]{1,4}$/i.test(h) ? parseInt(h, 16) : NaN));
  return parsed.some(Number.isNaN) ? null : parsed;
}

function isBlockedIpv6(h: number[]): boolean {
  const allZeroButLast = h.slice(0, 7).every((x) => x === 0);
  if (allZeroButLast && (h[7] === 0 || h[7] === 1)) return true; // :: and ::1
  if (h.slice(0, 5).every((x) => x === 0) && h[5] === 0xffff) {
    // IPv4-mapped: judge the embedded IPv4.
    return isBlockedIpv4([h[6] >> 8, h[6] & 0xff, h[7] >> 8, h[7] & 0xff]);
  }
  if ((h[0] & 0xfe00) === 0xfc00) return true; // fc00::/7 unique local
  if ((h[0] & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  if ((h[0] & 0xff00) === 0xff00) return true; // ff00::/8 multicast
  if (h[0] === 0x2001 && h[1] === 0x0db8) return true; // documentation
  if (h[0] === 0x0064 && h[1] === 0xff9b) return true; // NAT64 well-known
  return false;
}

/**
 * Throws BadRequestError when `raw` is not an acceptable webhook target.
 * Returns the normalized URL string otherwise.
 */
export function validateWebhookUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new BadRequestError("webhook url is not a valid URL");
  }
  if (url.protocol !== "https:") {
    throw new BadRequestError("webhook url must use https");
  }
  if (url.username || url.password) {
    throw new BadRequestError("webhook url must not carry credentials");
  }
  const host = url.hostname.toLowerCase();
  if (host.length === 0) throw new BadRequestError("webhook url has no host");

  const bracketed = host.startsWith("[") && host.endsWith("]");
  const bare = bracketed ? host.slice(1, -1) : host;
  const v4 = parseIpv4(bare);
  if (v4) {
    if (isBlockedIpv4(v4)) {
      throw new BadRequestError("webhook url must not target a private address");
    }
    return url.toString();
  }
  if (bracketed || bare.includes(":")) {
    const v6 = parseIpv6(bare);
    if (!v6 || isBlockedIpv6(v6)) {
      throw new BadRequestError("webhook url must not target a private address");
    }
    return url.toString();
  }
  // A dotted-decimal-looking host that failed strict parsing (octal,
  // shorthand like "127.1") is refused rather than guessed at.
  if (/^[\d.]+$/.test(bare)) throw new BadRequestError("webhook url host is malformed");
  if (BLOCKED_HOSTNAMES.has(bare) || BLOCKED_HOST_SUFFIXES.some((s) => bare.endsWith(s))) {
    throw new BadRequestError("webhook url must not target a local hostname");
  }
  if (!bare.includes(".")) throw new BadRequestError("webhook url host must be a public name");
  return url.toString();
}

// ── Subscriptions (org-scoped) ──

export interface CreateWebhookSubscriptionInput {
  organizationId: string;
  topic: string;
  /** A label the builder recognizes ("Zapier order sync"). */
  label: string;
  url: string;
  /** The NAME of the env var holding the signing secret. */
  secretRef: string;
  /** Retries after the first attempt. */
  retries?: number;
}

/**
 * Create an org-scoped webhook subscription. The URL is validated, the
 * secret env var must already be set (a webhook that can never sign
 * would only ever dead-letter), and (org, topic, label) is unique.
 */
export async function createWebhookSubscription(
  input: CreateWebhookSubscriptionInput,
): Promise<EventSubscriptionRow> {
  if (!TOPIC_PATTERN.test(input.topic)) {
    throw new BadRequestError("topic must be noun.past_tense (lowercase segments joined by dots)");
  }
  const label = input.label.trim();
  if (label.length === 0 || label.length > 120) {
    throw new BadRequestError("label must be 1 to 120 characters");
  }
  if (!SECRET_REF_PATTERN.test(input.secretRef)) {
    throw new BadRequestError("secretRef must be an environment variable name (UPPER_SNAKE_CASE)");
  }
  if (!readSecret(input.secretRef)) {
    throw new BadRequestError(`secret env var ${input.secretRef} is not set on this deployment`);
  }
  const url = validateWebhookUrl(input.url);
  const retries = input.retries ?? 7;
  if (!Number.isInteger(retries) || retries < 0 || retries > 30) {
    throw new BadRequestError("retries must be an integer from 0 to 30");
  }
  return await db
    .insertInto("event_subscriptions")
    .values({
      organizationId: input.organizationId,
      topic: input.topic,
      handler: label,
      kind: "webhook",
      maxAttempts: retries + 1,
      url,
      secretRef: input.secretRef,
    })
    .returningAll()
    .executeTakeFirstOrThrow();
}

export async function listWebhookSubscriptions(
  organizationId: string,
): Promise<EventSubscriptionRow[]> {
  return await db
    .selectFrom("event_subscriptions")
    .selectAll()
    .where("organizationId", "=", organizationId)
    .where("kind", "=", "webhook")
    .orderBy("createdAt", "desc")
    .execute();
}

/**
 * Deactivate (never delete: dead and pending deliveries stay visible).
 * The org id is in the WHERE, not only in the route (CWE-639).
 */
export async function deactivateWebhookSubscription(
  organizationId: string,
  subscriptionId: string,
): Promise<void> {
  const r = await db
    .updateTable("event_subscriptions")
    .set({ active: false })
    .where("id", "=", subscriptionId)
    .where("organizationId", "=", organizationId)
    .where("kind", "=", "webhook")
    .executeTakeFirst();
  if (Number(r.numUpdatedRows ?? 0) === 0) throw new NotFoundError("webhook subscription");
}

// ── Delivery ──

function readSecret(ref: string): string | undefined {
  try {
    const v = Deno.env.get(ref);
    return v && v.length > 0 ? v : undefined;
  } catch {
    return undefined;
  }
}

export interface DeliverWebhookOptions {
  /** Injected in tests; defaults to the global fetch. */
  fetch?: typeof fetch;
  timeoutMs?: number;
  /** Injected in tests to pin the signed timestamp. */
  nowMs?: () => number;
}

/**
 * POST one claimed delivery to its subscription's URL. Throws on any
 * outcome that is not a 2xx; the caller (processDelivery) turns the
 * throw into a failed attempt with backoff. Never logs the secret or
 * the response body beyond a short excerpt.
 */
export async function deliverWebhook(
  delivery: ClaimedDelivery,
  opts: DeliverWebhookOptions = {},
): Promise<void> {
  if (!delivery.url) throw new Error("webhook subscription has no url");
  if (!delivery.secretRef) throw new Error("webhook subscription has no secretRef");
  const url = validateWebhookUrl(delivery.url);
  const secret = readSecret(delivery.secretRef);
  if (!secret) throw new Error(`webhook secret env var ${delivery.secretRef} is not set`);

  const e = delivery.event;
  const body = JSON.stringify({
    id: e.id,
    topic: e.topic,
    key: e.key,
    payload: e.payload,
    source: e.source,
    createdAt: e.createdAt.toISOString(),
  });
  const timestamp = Math.floor((opts.nowMs ?? Date.now)() / 1_000);
  const doFetch = opts.fetch ?? fetch;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_WEBHOOK_TIMEOUT_MS;

  const res = await doFetch(url, {
    method: "POST",
    redirect: "manual",
    signal: AbortSignal.timeout(timeoutMs),
    headers: {
      "content-type": "application/json",
      "user-agent": "alchemist-events/1",
      [EVENT_ID_HEADER]: e.id,
      [EVENT_TOPIC_HEADER]: e.topic,
      [EVENT_TIMESTAMP_HEADER]: String(timestamp),
      [EVENT_SIGNATURE_HEADER]: signEventBody(secret, timestamp, body),
      [EVENT_DELIVERY_HEADER]: delivery.id,
      [EVENT_ATTEMPT_HEADER]: String(delivery.attempts),
    },
    body,
  });

  if (res.status >= 200 && res.status < 300) {
    // Drain so the connection is released; the body is not interesting.
    await res.body?.cancel();
    return;
  }
  let excerpt = "";
  try {
    excerpt = (await res.text()).slice(0, 200);
  } catch {
    // unreadable body: the status is enough
  }
  throw new Error(`webhook responded ${res.status}${excerpt ? `: ${excerpt}` : ""}`);
}
