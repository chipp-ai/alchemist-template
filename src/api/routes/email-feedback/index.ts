/**
 * Provider feedback: bounces and complaints from the mail provider.
 *
 *   POST /api/email-feedback
 *   Authorization: Bearer <EMAIL_FEEDBACK_TOKEN>
 *   { "events": [ { "type": "hard_bounce" | "complaint" | "soft_bounce" | "unsubscribe",
 *                   "email": "person@example.org",
 *                   "campaignId"?: "<uuid>",          // when the provider echoes it back
 *                   "organizationId"?: "<uuid>",      // unsubscribe only
 *                   "occurredAt"?: "<ISO 8601>",
 *                   "detail"?: "550 5.1.1 user unknown" } ] }
 *   -> 200 { data: { results: [ { email, type, action, campaignRecipientId } ] } }
 *
 * A hard bounce or a complaint suppresses the address app-wide, marks its
 * contacts suppressed, and lands on the campaign send it belongs to, which
 * is what lets the warm-up thresholds pause a bad list. See
 * src/services/mailing/suppression.service.ts.
 *
 * Auth: a shared secret in `EMAIL_FEEDBACK_TOKEN`, fail closed (unset = every
 * request 401s), compared in constant time. The caller is the platform,
 * relaying the provider's webhook (SMTP2GO bounce/spam events), not a
 * browser. NOT WIRED YET: the platform does not call this today. Until it
 * does, the endpoint is dormant and `GET /api/mailing/readiness` reports
 * `feedbackConnected: false`.
 */

import { Hono } from "hono";
import { createMiddleware } from "hono/factory";
import { bodyLimit } from "hono/body-limit";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { timingSafeEqual } from "node:crypto";
import { Buffer } from "node:buffer";
import { getEnv } from "@/lib/env.ts";
import { log } from "@/lib/logger.ts";
import { UnauthorizedError } from "@/utils/errors.ts";
import { validationHook } from "@/utils/zod-validation-hook.ts";
import { recordProviderFeedback } from "@/services/mailing/index.ts";

/** Events per request. A provider batch larger than this is split by the caller. */
export const MAX_FEEDBACK_EVENTS = 500;

function constantTimeEquals(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  return bufA.length === bufB.length && timingSafeEqual(bufA, bufB);
}

const requireFeedbackToken = createMiddleware(async (c, next) => {
  let expected = "";
  try {
    expected = getEnv("EMAIL_FEEDBACK_TOKEN") ?? "";
  } catch {
    expected = "";
  }
  if (!expected) {
    log.info("email-feedback rejected: EMAIL_FEEDBACK_TOKEN unset", { source: "mailing" });
    throw new UnauthorizedError("Email feedback is not configured");
  }
  const header = c.req.header("authorization") ?? "";
  const presented = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  if (!presented || !constantTimeEquals(presented, expected)) {
    throw new UnauthorizedError("Invalid or missing feedback token");
  }
  await next();
});

const eventSchema = z.object({
  type: z.enum(["hard_bounce", "complaint", "soft_bounce", "unsubscribe"]),
  email: z.string().trim().min(3).max(320).email(),
  campaignId: z.string().uuid().nullish(),
  organizationId: z.string().uuid().nullish(),
  occurredAt: z.string().datetime({ offset: true }).nullish(),
  detail: z.string().max(1000).nullish(),
});

const bodySchema = z.object({ events: z.array(eventSchema).min(1).max(MAX_FEEDBACK_EVENTS) });

const emailFeedbackRoutes = new Hono();

emailFeedbackRoutes.use("*", requireFeedbackToken);
emailFeedbackRoutes.use("*", bodyLimit({ maxSize: 1024 * 1024 }));

emailFeedbackRoutes.post("/", zValidator("json", bodySchema, validationHook), async (c) => {
  const { events } = c.req.valid("json");
  const results = [];
  for (const e of events) {
    results.push(
      await recordProviderFeedback({
        type: e.type,
        email: e.email,
        campaignId: e.campaignId ?? null,
        organizationId: e.organizationId ?? null,
        occurredAt: e.occurredAt ? new Date(e.occurredAt) : undefined,
        detail: e.detail ?? null,
      }),
    );
  }
  return c.json({ data: { results } });
});

export { emailFeedbackRoutes };
