/**
 * Event inbox: `POST /api/events/inbox`.
 *
 * The one door through which events from OUTSIDE this project enter its
 * durable log: platform events (credential rotations, deploy results,
 * R2 notifications relayed from a Cloudflare Queue) and relays from
 * external buses (a customer's Pub/Sub or Kafka). Each request is one
 * event; it lands in `events` with the sender's own id, so a sender
 * that retries can never create a duplicate.
 *
 * AUTH: HMAC-SHA256 over `${timestamp}.${rawBody}` with the shared
 * secret in `EVENTS_INBOX_SECRET` (src/lib/event-signing.ts). Read PER
 * REQUEST so ops can rotate without a restart. FAIL CLOSED: secret
 * unset means every request is 401; there is no "auth off in dev". The
 * timestamp bounds replay to a window (`EVENTS_INBOX_TOLERANCE_S`,
 * default 300); inside the window the event id de-duplicates.
 *
 * SCOPE IS THE DEPLOYMENT. The body carries no tenant, organization or
 * project id and none is read from it: an inbox event belongs to this
 * deployment as a whole (`organization_id` NULL). A handler that needs
 * an org resolves it from the payload's business keys server-side, the
 * way resolveIngestOrgId does for email.
 *
 * REJECTION LOG SEVERITY: a bad signature or a stale timestamp from the
 * internet is expected noise (info). `EVENTS_INBOX_SECRET` unset is OUR
 * misconfiguration, the inbox is off, and every platform event is being
 * dropped: that one is a warn so it surfaces.
 *
 *   201 { id, inserted: true, deliveries }   new event
 *   200 { id, inserted: false, deliveries: 0 }  seen before; nothing written
 */

import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import {
  DEFAULT_TIMESTAMP_TOLERANCE_S,
  EVENT_SIGNATURE_HEADER,
  EVENT_TIMESTAMP_HEADER,
  verifyEventSignature,
} from "@/lib/event-signing.ts";
import { publishEventAndNudge } from "@/lib/events.ts";
import { log } from "@/lib/logger.ts";
import { BadRequestError, UnauthorizedError } from "@/utils/errors.ts";

const LOG_SOURCE = "events-inbox";

/** One event per request; 1 MiB is generous for a notification. */
const INBOX_MAX_BODY_BYTES = 1024 * 1024;

const inboxEventSchema = z.object({
  id: z.string().uuid(),
  topic: z.string().min(3).max(200),
  key: z.string().max(500).nullish(),
  payload: z.record(z.unknown()).optional(),
  source: z.enum(["platform", "external"]),
});
// Unknown keys (an organizationId, a projectId, a tenant) are DROPPED by
// zod's default object parsing and never reach the insert. That is the
// "never trust a tenant id from the body" rule made structural.

function safeEnv(key: string): string | undefined {
  try {
    return Deno.env.get(key);
  } catch {
    return undefined;
  }
}

function toleranceSeconds(): number {
  const n = Number(safeEnv("EVENTS_INBOX_TOLERANCE_S") ?? "");
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_TIMESTAMP_TOLERANCE_S;
  return Math.min(60 * 60, Math.floor(n));
}

function reject(reason: string, severity: "warn" | "info" = "info"): never {
  const ctx = { source: LOG_SOURCE, feature: "auth", reason };
  if (severity === "warn") log.warn("events inbox rejected a delivery", ctx);
  else log.info("events inbox rejected a delivery", ctx);
  throw new UnauthorizedError("Invalid or missing event signature");
}

export const eventsRoutes = new Hono();

eventsRoutes.use(
  "/inbox",
  bodyLimit({
    maxSize: INBOX_MAX_BODY_BYTES,
    onError: (c) => c.json({ error: "Event too large", code: "PAYLOAD_TOO_LARGE" }, 413),
  }),
);

eventsRoutes.post("/inbox", async (c) => {
  const secret = safeEnv("EVENTS_INBOX_SECRET") ?? "";
  if (secret.length === 0) reject("EVENTS_INBOX_SECRET unset", "warn");

  // The signature covers the RAW bytes; parse only after it verifies.
  const rawBody = await c.req.text();
  const verdict = verifyEventSignature({
    secret,
    rawBody,
    timestampHeader: c.req.header(EVENT_TIMESTAMP_HEADER),
    signatureHeader: c.req.header(EVENT_SIGNATURE_HEADER),
    toleranceSeconds: toleranceSeconds(),
  });
  if (!verdict.ok) reject(verdict.reason);

  let json: unknown;
  try {
    json = JSON.parse(rawBody);
  } catch {
    throw new BadRequestError("Body must be JSON");
  }
  const parsed = inboxEventSchema.safeParse(json);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new BadRequestError(
      issue ? `${issue.path.join(".") || "body"}: ${issue.message}` : "Invalid event",
    );
  }
  const event = parsed.data;

  let result;
  try {
    result = await publishEventAndNudge({
      id: event.id,
      topic: event.topic,
      key: event.key ?? null,
      payload: event.payload ?? {},
      source: event.source,
      organizationId: null,
    });
  } catch (err) {
    // publishEvent validates the topic shape with a plain Error.
    if (err instanceof Error && /must be noun\.past_tense/.test(err.message)) {
      throw new BadRequestError(err.message);
    }
    throw err;
  }

  log.info("events inbox accepted a delivery", {
    source: LOG_SOURCE,
    feature: "inbox",
    eventId: result.id,
    topic: result.topic,
    eventSource: event.source,
    inserted: result.inserted,
    deliveries: result.deliveries,
  });
  return c.json(
    { id: result.id, inserted: result.inserted, deliveries: result.deliveries },
    result.inserted ? 201 : 200,
  );
});
