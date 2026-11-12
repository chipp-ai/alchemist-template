/**
 * POST /api/platform/member-sync
 *
 * The Chipp platform keeps the people who hold a role on the Chipp project
 * in step with this app's users. Server to server: the platform calls it,
 * never a browser. The reconcile itself is in
 * src/services/platform-member-sync.service.ts.
 *
 * Contract (fixed; the platform builds against it):
 *
 *   X-Event-Timestamp: <unix seconds>
 *   X-Event-Signature: v1=<hex HMAC-SHA256(ALCH_MEMBER_SYNC_SECRET, `${timestamp}.${rawBody}`)>
 *   { "projectId": "<uuid>", "seq": <integer, ms epoch>,
 *     "members": [{ "email": string, "name": string|null,
 *                   "role": "owner"|"editor"|"viewer" }] }   (at most 500)
 *
 *   -> 200 { ok: true, applied: true, orgId, created, updated, disconnected,
 *            skipped: [{ email, reason }] }
 *   -> 200 { ok: true, applied: false, reason: "stale_seq", lastSeq }
 *
 * What it refuses (fail closed):
 *   - 404 unless ALCH_MEMBER_SYNC_SECRET (32 chars or more) and PROJECT_ID
 *     are both set. The platform injects both; a stack without them looks
 *     exactly like a stack without the route.
 *   - 401 for a missing, malformed or wrong signature, or a timestamp more
 *     than 300 seconds from this server's clock (src/lib/event-signing.ts).
 *   - 400 for a body that is not the shape above, or that lists one email
 *     twice.
 *   - 403 when projectId is not this deploy's PROJECT_ID.
 *
 * Logs carry counts and reason slugs only: never the secret, the
 * signature, or a member's email.
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
import { getEnv } from "@/lib/env.ts";
import { log } from "@/lib/logger.ts";
import {
  applyMemberSync,
  MEMBER_SYNC_MAX_MEMBERS,
  normalizeEmail,
  PLATFORM_ROLES,
} from "@/services/platform-member-sync.service.ts";
import {
  BadRequestError,
  ForbiddenError,
  NotFoundError,
  UnauthorizedError,
} from "@/utils/errors.ts";

const LOG_SOURCE = "platform-member-sync";
const MAX_BODY_BYTES = 512 * 1024;

/** Both env values, or null when the route is disabled on this deploy. */
export function memberSyncConfig(): { secret: string; projectId: string } | null {
  const secret = getEnv("ALCH_MEMBER_SYNC_SECRET")?.trim() ?? "";
  const projectId = getEnv("PROJECT_ID")?.trim() ?? "";
  // The platform injects a 64-char hex value. A short one is a
  // misconfiguration, never a real secret: treat it as absent.
  if (secret.length < 32 || !projectId) return null;
  return { secret, projectId };
}

const memberSchema = z.object({
  email: z.string().trim().email().max(255),
  name: z.string().trim().max(255).nullable(),
  role: z.enum(PLATFORM_ROLES),
});

const bodySchema = z.object({
  projectId: z.string().min(1).max(100),
  seq: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  members: z.array(memberSchema).max(MEMBER_SYNC_MAX_MEMBERS),
});

export const platformMemberSyncRoutes = new Hono();

platformMemberSyncRoutes.use(
  "/member-sync",
  bodyLimit({
    maxSize: MAX_BODY_BYTES,
    onError: (c) => c.json({ error: "Body too large", code: "PAYLOAD_TOO_LARGE" }, 413),
  }),
);

platformMemberSyncRoutes.post("/member-sync", async (c) => {
  const config = memberSyncConfig();
  if (!config) throw new NotFoundError("Route not found");

  // The signature covers the raw bytes; parse only after it verifies.
  const rawBody = await c.req.text();
  const verdict = verifyEventSignature({
    secret: config.secret,
    rawBody,
    timestampHeader: c.req.header(EVENT_TIMESTAMP_HEADER),
    signatureHeader: c.req.header(EVENT_SIGNATURE_HEADER),
    toleranceSeconds: DEFAULT_TIMESTAMP_TOLERANCE_S,
  });
  if (!verdict.ok) {
    log.info("member sync rejected a delivery", {
      source: LOG_SOURCE,
      feature: "auth",
      reason: verdict.reason,
    });
    throw new UnauthorizedError("Invalid or missing signature");
  }

  let json: unknown;
  try {
    json = JSON.parse(rawBody);
  } catch {
    throw new BadRequestError("Body must be JSON");
  }
  const parsed = bodySchema.safeParse(json);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new BadRequestError(
      issue ? `${issue.path.join(".") || "body"}: ${issue.message}` : "Invalid body",
    );
  }
  const body = parsed.data;

  if (body.projectId !== config.projectId) {
    log.warn("member sync for another project", { source: LOG_SOURCE, feature: "auth" });
    throw new ForbiddenError("Wrong project");
  }

  const seen = new Set<string>();
  for (const m of body.members) {
    const email = normalizeEmail(m.email);
    if (seen.has(email)) throw new BadRequestError("members: an email is listed more than once");
    seen.add(email);
  }

  const result = await applyMemberSync({
    seq: body.seq,
    members: body.members.map((m) => ({
      email: normalizeEmail(m.email),
      name: m.name && m.name.length > 0 ? m.name : null,
      role: m.role,
    })),
  });

  c.header("Cache-Control", "no-store");
  if (!result.applied) {
    log.info("member sync ignored a stale delivery", {
      source: LOG_SOURCE,
      feature: "reconcile",
      seq: body.seq,
      lastSeq: result.lastSeq,
    });
    return c.json({ ok: true, applied: false, reason: result.reason, lastSeq: result.lastSeq });
  }

  log.info("member sync applied", {
    source: LOG_SOURCE,
    feature: "reconcile",
    seq: body.seq,
    orgId: result.orgId,
    members: body.members.length,
    created: result.created,
    updated: result.updated,
    disconnected: result.disconnected,
    skipped: result.skipped.length,
  });
  return c.json({
    ok: true,
    applied: true,
    orgId: result.orgId,
    created: result.created,
    updated: result.updated,
    disconnected: result.disconnected,
    skipped: result.skipped,
  });
});
