/**
 * Inbound EMAIL-ingestion route -- `POST /api/ingest/email`.
 *
 * Postmark inbound webhook handler. Persists the forwarded email + its
 * attachments durably (capture-first). NO extraction here -- rows land at
 * status='received' for the background reaper to project
 * (src/jobs/inbound-email-reaper.ts).
 *
 * Auth: shared-secret token in `INGEST_EMAIL_TOKEN` (fail-closed: unset
 * => every request 401s). NOT session-cookie based -- the caller is
 * Postmark, not a browser. See src/api/middleware/ingest-email-token.ts.
 *
 * Tenant: resolved SERVER-SIDE in the capture service via
 * resolveIngestOrgId() (the INGEST_ORG_ID env var); the body never
 * carries an organizationId.
 *
 * Boundedness: a hard body-size limit (413) caps total request bytes,
 * and the zod schema caps Attachments[]/Headers[] cardinality -- a 1000-
 * attachment or oversized-body request is bounded, not an OOM.
 */

import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { validationHook } from "@/utils/zod-validation-hook.ts";
import { requireIngestEmailToken } from "@/api/middleware/ingest-email-token.ts";
import { captureInboundEmail } from "@/services/inbound-email/capture.service.ts";

/**
 * Hard cap on the raw request body. Postmark's inbound message limit is
 * 35 MB (the original message); delivered as JSON with base64-encoded
 * attachments it inflates ~1.37x, so 60 MB is comfortable headroom for a
 * legitimate payload while still bounding a malicious one.
 */
const INBOUND_EMAIL_MAX_BODY_BYTES = 60 * 1024 * 1024;

const headerSchema = z
  .object({ Name: z.string(), Value: z.string() })
  .passthrough();

const attachmentSchema = z
  .object({
    Name: z.string().optional(),
    Content: z.string().optional(),
    ContentType: z.string().optional(),
    ContentLength: z.number().optional(),
    ContentID: z.string().optional(),
  })
  .passthrough();

// Postmark owns this shape, so `.passthrough()` (NOT `.strict()`) --
// unknown Postmark fields survive but aren't relied on. Cardinality is
// capped so a huge Attachments[]/Headers[] can't blow past the body
// limit's intent.
const postmarkInboundSchema = z
  .object({
    From: z.string().optional(),
    To: z.string().optional(),
    OriginalRecipient: z.string().optional(),
    Subject: z.string().optional(),
    TextBody: z.string().optional(),
    HtmlBody: z.string().optional(),
    MessageID: z.string().optional(),
    Headers: z.array(headerSchema).max(1000).optional(),
    Attachments: z.array(attachmentSchema).max(1000).optional(),
    RawEmail: z.string().optional(),
  })
  .passthrough();

const ingestEmailRoutes = new Hono();

// Auth first (header/query only, cheap) so we never read/measure the body
// of an unauthorized request. Then the body-size limit, then zod parse.
ingestEmailRoutes.use("*", requireIngestEmailToken);
ingestEmailRoutes.use(
  "*",
  bodyLimit({
    maxSize: INBOUND_EMAIL_MAX_BODY_BYTES,
    onError: (c) =>
      c.json({ error: "Inbound email payload too large", code: "PAYLOAD_TOO_LARGE" }, 413),
  }),
);

ingestEmailRoutes.post(
  "/",
  zValidator("json", postmarkInboundSchema, validationHook),
  async (c) => {
    const payload = c.req.valid("json");
    // Capture is synchronous + idempotent; a genuine storage/DB outage
    // throws and surfaces as 5xx so Postmark retries (message-id dedup
    // makes the retry safe). Nothing about extraction can make this fail.
    const result = await captureInboundEmail(payload);
    return c.json(
      { data: { id: result.id, deduplicated: result.deduplicated } },
      result.deduplicated ? 200 : 201,
    );
  },
);

export { ingestEmailRoutes };
