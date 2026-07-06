/**
 * Bearer-token middleware for the inbound EMAIL-ingestion endpoint.
 *
 *   POST /api/ingest/email   -- Postmark inbound webhook -> raw capture.
 *
 * Shared secret in `INGEST_EMAIL_TOKEN` (read PER REQUEST, never at module
 * load, so ops can rotate without a restart and tests can set/unset it).
 * NOT session-cookie based -- the caller is Postmark, not a browser.
 *
 * FAIL CLOSED: if `INGEST_EMAIL_TOKEN` is unset / empty, EVERY request
 * 401s. There is no "auth disabled in dev" affordance -- an open inbound
 * webhook lets anyone on the internet write into inbound_email + spend
 * storage.
 *
 * Constant-time comparison via Node's `crypto.timingSafeEqual` so an
 * attacker can't byte-by-byte probe the secret with timing. We length-
 * check first and bail with `false` on mismatch -- timingSafeEqual throws
 * on different-length buffers, and the length itself is a timing signal
 * we don't want to leak.
 *
 * NEVER log the token. Only a reason slug is logged -- never the raw
 * Authorization header or query value.
 *
 * REJECTION LOG SEVERITY: external-caller rejections (a wrong/missing
 * token from an internet probe or a misconfigured sender) are EXPECTED
 * noise and log at `info`. Our-side misconfiguration (`INGEST_EMAIL_TOKEN`
 * unset -- the webhook is effectively OFF and inbound email is being
 * dropped) stays at `warn` so it surfaces in monitoring.
 */

import { createMiddleware } from "hono/factory";
import { timingSafeEqual } from "node:crypto";
import { Buffer } from "node:buffer";
import { log } from "@/lib/logger.ts";
import { UnauthorizedError } from "@/utils/errors.ts";

const BEARER_PREFIX = "Bearer ";

function constantTimeEquals(a: string, b: string): boolean {
  // Length must match for timingSafeEqual to even run; bail early.
  // Skipping this would surface a TypeError ("Input buffers must have
  // the same byte length") and incidentally leak length via timing.
  if (a.length !== b.length) return false;
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

/**
 * Reject with a 401. `severity` controls the log level of the rejection
 * line (NOT the response, which is always 401). Defaults to `info` --
 * external-caller probe noise. Pass `"warn"` only for our-side
 * misconfiguration (token unset).
 */
function reject(reason: string, severity: "warn" | "info" = "info"): never {
  const payload = { source: "ingest-email-webhook", feature: "auth", reason };
  if (severity === "warn") {
    log.warn("ingest-email-webhook auth rejected", payload);
  } else {
    log.info("ingest-email-webhook auth rejected", payload);
  }
  throw new UnauthorizedError("Invalid or missing ingest token");
}

/**
 * Token gate for `POST /api/ingest/email` (accepts `?token=` query param --
 * Postmark's only option, it can't set headers -- OR `Authorization: Bearer`
 * for server-to-server callers/tests). Apply BEFORE the bodyLimit /
 * zValidator so we never spend cycles on an unauthorized (potentially
 * large) payload.
 */
export const requireIngestEmailToken = createMiddleware(async (c, next) => {
  let expected = "";
  try {
    expected = Deno.env.get("INGEST_EMAIL_TOKEN") ?? "";
  } catch {
    // No --allow-env: treat as unset (fail closed below).
  }
  if (!expected || expected.length === 0) {
    // Fail closed: no configured secret == endpoint off. This is OUR
    // misconfiguration -- warn so monitoring surfaces a webhook that is
    // dropping all inbound email.
    reject("INGEST_EMAIL_TOKEN unset", "warn");
  }

  const header = c.req.header("Authorization") ?? c.req.header("authorization") ?? "";
  const bearer = header.startsWith(BEARER_PREFIX) ? header.slice(BEARER_PREFIX.length).trim() : "";
  const queryToken = (c.req.query("token") ?? "").trim();
  const presented = bearer || queryToken;
  if (presented.length === 0) {
    // External caller / probe with no credential -- expected internet noise.
    reject("no bearer header and no ?token= query param");
  }

  if (!constantTimeEquals(presented, expected)) {
    // External caller / probe with the wrong credential -- expected noise.
    reject("token mismatch");
  }

  // No user / organizationId in context -- the tenant is resolved server-
  // side in the capture service via resolveIngestOrgId(), never from the
  // request body.
  await next();
});
