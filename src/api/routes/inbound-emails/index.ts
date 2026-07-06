/**
 * Inbound-email dashboard API -- auth-gated, ORG-SCOPED reads over the
 * captured inbound_email rows.
 *
 *   GET /api/inbound-emails       -- list (newest first; ?status= and ?limit=)
 *   GET /api/inbound-emails/:id   -- one email + attachments (+ signed URLs)
 *
 * SCOPING: every query filters `organization_id = getUser(c).organizationId`.
 * Rows captured with organization_id NULL (INGEST_ORG_ID unset/invalid at
 * capture time) are DELIBERATELY invisible here -- set INGEST_ORG_ID in
 * production so captured emails attribute to the org that should see them.
 *
 * The :id lookup returns a UNIFORM NotFoundError for malformed ids,
 * unknown ids, and cross-org ids alike -- no existence oracle.
 */

import { Hono } from "hono";
import { db } from "@/db/client.ts";
import { getUser, requireAuth } from "@/api/middleware/auth.ts";
import { BadRequestError, NotFoundError } from "@/utils/errors.ts";
import { getSignedDownloadUrl, isStorageConfigured } from "@/services/storage.service.ts";
import type { InboundEmailStatus } from "@/db/schema.ts";

const VALID_STATUSES: ReadonlySet<string> = new Set([
  "received",
  "extracted",
  "human_message",
  "unclear",
  "failed",
]);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Signed-URL TTL for attachment/raw-MIME downloads. */
const DOWNLOAD_URL_TTL_SECONDS = 900;

const inboundEmailRoutes = new Hono();

inboundEmailRoutes.use("*", requireAuth);

// List: newest first, optional status filter (comma list) + limit.
inboundEmailRoutes.get("/", async (c) => {
  const organizationId = getUser(c).organizationId;

  // ?status=received,failed -- validated against the enum so a typo is a
  // clear 400, not a silently-empty result.
  const statusParam = (c.req.query("status") ?? "").trim();
  let statuses: InboundEmailStatus[] | null = null;
  if (statusParam) {
    const parts = statusParam.split(",").map((s) => s.trim()).filter((s) => s.length > 0);
    for (const p of parts) {
      if (!VALID_STATUSES.has(p)) {
        throw new BadRequestError(
          `Invalid status '${p}'. Valid: ${[...VALID_STATUSES].join(", ")}`,
        );
      }
    }
    // Guard the Kysely whereIn-empty-array crash: an all-whitespace param
    // parses to zero entries -> treat as "no filter".
    statuses = parts.length > 0 ? parts as InboundEmailStatus[] : null;
  }

  // ?limit= default 50, max 200; NaN sanitized to the default.
  const rawLimit = parseInt(c.req.query("limit") ?? "", 10);
  const limit = Math.min(Math.max(Number.isFinite(rawLimit) ? rawLimit : 50, 1), 200);

  let query = db
    .selectFrom("inbound_email")
    .select([
      "id",
      "fromAddress",
      "toAddress",
      "subject",
      "status",
      "statusReason",
      "attachmentCount",
      "receivedAt",
      "processedAt",
    ])
    .where("organizationId", "=", organizationId)
    .orderBy("receivedAt", "desc")
    .limit(limit);
  if (statuses) {
    query = query.where("status", "in", statuses);
  }
  const rows = await query.execute();

  return c.json({ data: { emails: rows } });
});

// Detail: one email + its attachments, with signed download URLs for
// stored objects when storage is configured.
inboundEmailRoutes.get("/:id", async (c) => {
  const organizationId = getUser(c).organizationId;
  const id = c.req.param("id");

  // Malformed id -> the SAME 404 as unknown/cross-org (uniform response,
  // and it never reaches the DB as a non-UUID that would 500 the cast).
  if (!UUID_RE.test(id)) {
    throw new NotFoundError("Inbound email");
  }

  const email = await db
    .selectFrom("inbound_email")
    .select([
      "id",
      "fromAddress",
      "toAddress",
      "subject",
      "status",
      "statusReason",
      "attachmentCount",
      "receivedAt",
      "processedAt",
      "bodyText",
      "bodyHtml",
      "headers",
      "applyResult",
      "rawMimeKey",
    ])
    .where("id", "=", id)
    .where("organizationId", "=", organizationId)
    .executeTakeFirst();

  if (!email) {
    throw new NotFoundError("Inbound email");
  }

  const attachmentRows = await db
    .selectFrom("inbound_email_attachment")
    .select(["id", "filename", "contentType", "sizeBytes", "r2Key"])
    .where("inboundEmailId", "=", email.id)
    .orderBy("createdAt", "asc")
    .execute();

  const storageOk = isStorageConfigured();

  const attachments = attachmentRows.map((a) => {
    const stored = a.r2Key !== "";
    return {
      id: a.id,
      filename: a.filename,
      contentType: a.contentType,
      sizeBytes: a.sizeBytes,
      stored,
      downloadUrl: stored && storageOk
        ? getSignedDownloadUrl(a.r2Key, DOWNLOAD_URL_TTL_SECONDS)
        : null,
    };
  });

  const { rawMimeKey, ...emailFields } = email;
  const rawMimeUrl = rawMimeKey && storageOk
    ? getSignedDownloadUrl(rawMimeKey, DOWNLOAD_URL_TTL_SECONDS)
    : null;

  return c.json({
    data: {
      email: { ...emailFields, rawMimeUrl },
      attachments,
    },
  });
});

export { inboundEmailRoutes };
