/**
 * Mailing-list admin routes: contacts, campaigns, readiness.
 *
 *   GET    /api/mailing/readiness              can campaigns send? what to fix
 *   GET    /api/mailing/contacts               list (?status=&origin=&limit=&offset=)
 *   GET    /api/mailing/contacts/counts        subscribed / unsubscribed / suppressed / cold
 *   POST   /api/mailing/contacts               add one by hand { email, firstName?, lastName?, attestation }
 *   GET    /api/mailing/campaigns              list
 *   POST   /api/mailing/campaigns              create a draft { name, subject, text, html? }
 *   GET    /api/mailing/campaigns/:id          campaign + counts + warm-up + skipped reasons
 *   PATCH  /api/mailing/campaigns/:id          edit a draft
 *   POST   /api/mailing/campaigns/:id/send     start now, or { sendAt } to schedule
 *   POST   /api/mailing/campaigns/:id/pause
 *   POST   /api/mailing/campaigns/:id/resume
 *   POST   /api/mailing/campaigns/:id/cancel
 *
 * Bulk import goes through the import wizard (`email_contacts`
 * definition, /api/imports), not through here.
 *
 * Every route needs `email.broadcast` (admin and up). Every service query
 * is org-scoped by the session user's organization (CWE-639).
 *
 * A send or schedule from a deployment without a verified sending domain
 * answers 409 SENDER_DOMAIN_REQUIRED with the fix in `error`.
 */

import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { getUser, requireAuth, requireCapability } from "@/api/middleware/auth.ts";
import { validationHook } from "@/utils/zod-validation-hook.ts";
import { BadRequestError } from "@/utils/errors.ts";
import {
  addManualContact,
  campaignReport,
  cancelCampaign,
  contactCounts,
  createCampaign,
  listCampaigns,
  listContacts,
  mailingReadiness,
  pauseCampaign,
  resumeCampaign,
  startCampaign,
  updateCampaign,
} from "@/services/mailing/index.ts";

const mailingRoutes = new Hono();

mailingRoutes.use("*", requireAuth);
mailingRoutes.use("*", requireCapability("email.broadcast"));

mailingRoutes.get("/readiness", (c) => c.json({ data: mailingReadiness() }));

// ── Contacts ─────────────────────────────────────────────────────────────

const listContactsQuery = z.object({
  status: z.enum(["subscribed", "unsubscribed", "suppressed"]).optional(),
  origin: z.enum(["signup", "import", "manual"]).optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

mailingRoutes.get(
  "/contacts",
  zValidator("query", listContactsQuery, validationHook),
  async (c) => {
    const user = getUser(c);
    const q = c.req.valid("query");
    return c.json({ data: await listContacts({ organizationId: user.organizationId, ...q }) });
  },
);

mailingRoutes.get("/contacts/counts", async (c) => {
  const user = getUser(c);
  return c.json({ data: await contactCounts(user.organizationId) });
});

const addContactSchema = z.object({
  email: z.string().trim().min(3).max(320),
  firstName: z.string().trim().max(200).nullish(),
  lastName: z.string().trim().max(200).nullish(),
  attestation: z.object({
    listSource: z.string(),
    listSourceDetail: z.string().nullish(),
    optedIn: z.boolean(),
  }).passthrough(),
});

mailingRoutes.post("/contacts", zValidator("json", addContactSchema, validationHook), async (c) => {
  const user = getUser(c);
  const body = c.req.valid("json");
  const row = await addManualContact({
    organizationId: user.organizationId,
    userId: user.id,
    email: body.email,
    firstName: body.firstName ?? null,
    lastName: body.lastName ?? null,
    attestation: body.attestation,
  });
  return c.json({ data: row }, 201);
});

// ── Campaigns ────────────────────────────────────────────────────────────

const contentSchema = z.object({
  name: z.string().trim().min(1).max(200),
  subject: z.string().trim().min(1).max(300),
  text: z.string().min(1).max(200_000),
  html: z.string().max(500_000).nullish(),
});

mailingRoutes.get("/campaigns", async (c) => {
  const user = getUser(c);
  return c.json({ data: await listCampaigns({ organizationId: user.organizationId }) });
});

mailingRoutes.post("/campaigns", zValidator("json", contentSchema, validationHook), async (c) => {
  const user = getUser(c);
  const body = c.req.valid("json");
  const row = await createCampaign({
    ...body,
    organizationId: user.organizationId,
    userId: user.id,
  });
  return c.json({ data: row }, 201);
});

mailingRoutes.get("/campaigns/:id", async (c) => {
  const user = getUser(c);
  return c.json({
    data: await campaignReport({ id: c.req.param("id"), organizationId: user.organizationId }),
  });
});

mailingRoutes.patch(
  "/campaigns/:id",
  zValidator("json", contentSchema, validationHook),
  async (c) => {
    const user = getUser(c);
    const row = await updateCampaign({
      ...c.req.valid("json"),
      id: c.req.param("id") ?? "",
      organizationId: user.organizationId,
    });
    return c.json({ data: row });
  },
);

const sendSchema = z.object({ sendAt: z.string().datetime({ offset: true }).nullish() });

// The body is optional (no body = send now), so it is read by hand rather
// than through zValidator, which refuses a request with no JSON body.
mailingRoutes.post("/campaigns/:id/send", async (c) => {
  const user = getUser(c);
  let raw: unknown = {};
  if ((c.req.header("content-type") ?? "").includes("application/json")) {
    try {
      raw = await c.req.json();
    } catch {
      throw new BadRequestError("The request body is not valid JSON.");
    }
  }
  const parsed = sendSchema.safeParse(raw ?? {});
  if (!parsed.success) throw new BadRequestError("sendAt must be an ISO 8601 date-time.");
  const row = await startCampaign({
    id: c.req.param("id"),
    organizationId: user.organizationId,
    sendAt: parsed.data.sendAt ? new Date(parsed.data.sendAt) : null,
  });
  return c.json({ data: row });
});

mailingRoutes.post("/campaigns/:id/pause", async (c) => {
  const user = getUser(c);
  const row = await pauseCampaign({
    id: c.req.param("id"),
    organizationId: user.organizationId,
    reason: `Paused by ${user.email}.`,
  });
  return c.json({ data: row });
});

mailingRoutes.post("/campaigns/:id/resume", async (c) => {
  const user = getUser(c);
  return c.json({
    data: await resumeCampaign({ id: c.req.param("id"), organizationId: user.organizationId }),
  });
});

mailingRoutes.post("/campaigns/:id/cancel", async (c) => {
  const user = getUser(c);
  return c.json({
    data: await cancelCampaign({ id: c.req.param("id"), organizationId: user.organizationId }),
  });
});

export { mailingRoutes };
