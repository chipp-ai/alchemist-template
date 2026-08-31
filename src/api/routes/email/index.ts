/**
 * Email admin routes -- preview, test send, and the communications toggles.
 *
 *   GET    /api/email/kinds                  - list registered kinds   (admin, or dev)
 *   GET    /api/email/kinds/:kind/preview    - render with sample data (admin, or dev)
 *   POST   /api/email/test                   - send a [TEST] message   (admin)
 *   GET    /api/email/settings               - both toggles            (any auth)
 *   PATCH  /api/email/settings/org           - org master switch       (admin)
 *   PATCH  /api/email/settings/me            - personal switch         (any auth)
 *
 * Why the org toggle and the personal toggle are SEPARATE endpoints
 * rather than one PATCH with two optional fields: relaxing a mutation
 * route's gate widens it for every field in the payload. The personal
 * switch has to be writable by any signed-in user, including a viewer;
 * the org switch must not be. Two routes keep each gate honest.
 *
 * The test send deliberately bypasses the communications gate -- see
 * `sendTestEmail` in src/services/email-kinds.ts.
 */

import { Hono } from "hono";
import { createMiddleware } from "hono/factory";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { getUser, requireAuth, requireCapability } from "@/api/middleware/auth.ts";
import { validationHook } from "@/utils/zod-validation-hook.ts";
import { ForbiddenError, UnauthorizedError } from "@/utils/errors.ts";
import { can } from "@/lib/roles.ts";
import { devRoutesEnabled } from "@/lib/dev-mode.ts";
import { log } from "@/lib/logger.ts";
import {
  getOrgCommunicationsEnabled,
  getUserCommunicationsEnabled,
  listEmailKinds,
  renderEmailKindPreview,
  sendTestEmail,
  setOrgCommunicationsEnabled,
  setUserCommunicationsEnabled,
} from "@/services/email.ts";

const emailRoutes = new Hono();

// Every route here needs a signed-in user. The per-route gates below add
// the capability requirement where one applies.
emailRoutes.use("*", requireAuth);

/**
 * Read-only preview surfaces are open to org admins, and to any signed-in
 * user when the fail-closed dev surface is enabled (ALCHEMIST_DEV_ROUTES,
 * see src/lib/dev-mode.ts). The dev relaxation exists so an agent
 * verifying a template flow can eyeball a rendered email without first
 * promoting itself to admin. It can never apply in production: nothing in
 * the customer deploy path sets that flag.
 *
 * Reads only. The test SEND below is admin-only with no dev bypass,
 * because it actually delivers a message.
 */
const requireAdminOrDev = createMiddleware(async (c, next) => {
  const user = c.get("user") as { role: string } | undefined;
  if (!user) throw new UnauthorizedError("Authentication required");
  if (!can(user.role, "org.update") && !devRoutesEnabled()) {
    throw new ForbiddenError(
      `Your role (${user.role}) cannot preview emails.`,
    );
  }
  await next();
});

// ── GET /kinds ────────────────────────────────────────────────────────────

emailRoutes.get("/kinds", requireAdminOrDev, (c) => {
  return c.json({ data: listEmailKinds() });
});

// ── GET /kinds/:kind/preview ──────────────────────────────────────────────
//
// Default response is `text/html` so a browser (or an iframe in the admin
// UI) renders it directly. `?format=json` returns the subject + text +
// html separately for a test or a side-by-side view.
//
// The rendered body is OUR OWN template filled with the kind's sample
// data. No request input reaches the HTML: the `:kind` segment only
// selects a registered definition and 404s otherwise.

emailRoutes.get("/kinds/:kind/preview", requireAdminOrDev, (c) => {
  const kind = c.req.param("kind");
  const rendered = renderEmailKindPreview(kind);

  if (c.req.query("format") === "json") {
    return c.json({ data: { kind, ...rendered } });
  }

  return c.html(rendered.html);
});

// ── POST /test ────────────────────────────────────────────────────────────

const testSendSchema = z.object({
  kind: z.string().trim().min(1),
  /**
   * Where to send it. Defaults to the requesting admin's own address,
   * which is the safe default: a test send should land in the mailbox of
   * the person who pressed the button, never somewhere they typed by
   * accident.
   */
  to: z.string().email().trim().toLowerCase().optional(),
});

emailRoutes.post(
  "/test",
  requireCapability("org.update"),
  zValidator("json", testSendSchema, validationHook),
  async (c) => {
    const user = getUser(c);
    const body = c.req.valid("json");
    const to = body.to ?? user.email;

    const rendered = await sendTestEmail({
      kind: body.kind,
      to,
      organizationId: user.organizationId,
    });

    log.info("Test email sent", {
      source: "email",
      feature: "test-send",
      kind: body.kind,
      to,
      requestedBy: user.id,
      organizationId: user.organizationId,
    });

    return c.json({ data: { kind: body.kind, to, subject: rendered.subject } });
  },
);

// ── GET /settings ─────────────────────────────────────────────────────────

emailRoutes.get("/settings", async (c) => {
  const user = getUser(c);
  const [org, me] = await Promise.all([
    getOrgCommunicationsEnabled(user.organizationId),
    getUserCommunicationsEnabled(user.id),
  ]);
  return c.json({
    data: {
      organizationId: user.organizationId,
      orgCommunicationsEnabled: org,
      userCommunicationsEnabled: me,
      /** Both must be on for ordinary mail. Auth-critical mail ignores both. */
      effectiveCommunicationsEnabled: org && me,
      canManageOrgSetting: can(user.role, "org.update"),
    },
  });
});

// ── PATCH /settings/org ───────────────────────────────────────────────────

const toggleSchema = z.object({ communicationsEnabled: z.boolean() });

emailRoutes.patch(
  "/settings/org",
  requireCapability("org.update"),
  zValidator("json", toggleSchema, validationHook),
  async (c) => {
    const user = getUser(c);
    const { communicationsEnabled } = c.req.valid("json");
    const stored = await setOrgCommunicationsEnabled(
      user.organizationId,
      communicationsEnabled,
    );
    return c.json({ data: { orgCommunicationsEnabled: stored } });
  },
);

// ── PATCH /settings/me ────────────────────────────────────────────────────
//
// Writes `users.preferences.communicationsEnabled`. Equivalent to
// PATCH /api/auth/me/preferences with the same key; this route exists so
// the communications surface is discoverable in one place.

emailRoutes.patch(
  "/settings/me",
  zValidator("json", toggleSchema, validationHook),
  async (c) => {
    const user = getUser(c);
    const { communicationsEnabled } = c.req.valid("json");
    const stored = await setUserCommunicationsEnabled(user.id, communicationsEnabled);
    return c.json({ data: { userCommunicationsEnabled: stored } });
  },
);

export { emailRoutes };
