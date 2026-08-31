/**
 * /api/email -- kind list, preview, test send, communications toggles.
 *
 * Gating is the bulk of it. The preview surfaces are read-only and open to
 * admins (or to anyone when the fail-closed dev flag is on); the test send
 * actually delivers, so it is admin-only with no dev bypass; and the two
 * toggles live on SEPARATE endpoints so relaxing the personal one can
 * never widen the org one.
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import { createIsolatedUser, withTestServer } from "../helpers.ts";
import { createSessionToken } from "@/api/middleware/auth.ts";
import { emailRoutes } from "@/api/routes/email/index.ts";
import {
  clearCapturedEmails,
  getOrgCommunicationsEnabled,
  getUserCommunicationsEnabled,
  lastCapturedEmail,
  TEST_EMAIL_SUBJECT_PREFIX,
} from "@/services/email.ts";

const HAS_DB = !!(Deno.env.get("TEST_DATABASE_URL") || Deno.env.get("DATABASE_URL"));

function dbTest(name: string, fn: () => Promise<void>) {
  Deno.test({ name, ignore: !HAS_DB, sanitizeResources: false, sanitizeOps: false, fn });
}

function buildApp() {
  return withTestServer((app) => {
    app.route("/api/email", emailRoutes);
  });
}

async function cookieFor(user: {
  id: string;
  email: string;
  name: string | null;
  organizationId: string;
  role: string;
}): Promise<string> {
  const token = await createSessionToken(user);
  return `session_id=${token}`;
}

/** Dev flag OFF for every test here, so admin gating is what is measured. */
function setDevRoutes(value: string | null): () => void {
  const prev = Deno.env.get("ALCHEMIST_DEV_ROUTES");
  if (value === null) Deno.env.delete("ALCHEMIST_DEV_ROUTES");
  else Deno.env.set("ALCHEMIST_DEV_ROUTES", value);
  return () => {
    if (prev === undefined) Deno.env.delete("ALCHEMIST_DEV_ROUTES");
    else Deno.env.set("ALCHEMIST_DEV_ROUTES", prev);
  };
}

// ── Preview gating ────────────────────────────────────────────────────────

dbTest("preview: unauthenticated is 401", async () => {
  const restore = setDevRoutes(null);
  try {
    const app = buildApp();
    assertEquals((await app.request("/api/email/kinds")).status, 401);
    assertEquals((await app.request("/api/email/kinds/otp/preview")).status, 401);
  } finally {
    restore();
  }
});

dbTest("preview: a viewer is 403 when the dev surface is off", async () => {
  const restore = setDevRoutes(null);
  const ctx = await createIsolatedUser("viewer");
  try {
    const app = buildApp();
    const cookie = await cookieFor({ ...ctx.user, role: "viewer" });
    const res = await app.request("/api/email/kinds/otp/preview", { headers: { cookie } });
    assertEquals(res.status, 403);
  } finally {
    restore();
    await ctx.cleanup();
  }
});

dbTest("preview: a viewer IS allowed once the dev surface is on", async () => {
  const restore = setDevRoutes("1");
  const ctx = await createIsolatedUser("viewer");
  try {
    const app = buildApp();
    const cookie = await cookieFor({ ...ctx.user, role: "viewer" });
    const res = await app.request("/api/email/kinds/otp/preview", { headers: { cookie } });
    assertEquals(res.status, 200);
  } finally {
    restore();
    await ctx.cleanup();
  }
});

dbTest("preview: an admin gets the kind list and rendered HTML", async () => {
  const restore = setDevRoutes(null);
  const ctx = await createIsolatedUser("owner");
  try {
    const app = buildApp();
    const cookie = await cookieFor({ ...ctx.user, role: "owner" });

    const kinds = await (await app.request("/api/email/kinds", { headers: { cookie } })).json();
    const names = kinds.data.map((k: { kind: string }) => k.kind);
    assertEquals(names.includes("invite"), true);
    assertEquals(names.includes("expiration_digest"), true);

    const html = await app.request("/api/email/kinds/invite/preview", { headers: { cookie } });
    assertEquals(html.status, 200);
    assertStringIncludes(html.headers.get("content-type") ?? "", "text/html");
    assertStringIncludes(await html.text(), "<!doctype html>");

    const json = await app.request("/api/email/kinds/invite/preview?format=json", {
      headers: { cookie },
    });
    const body = await json.json();
    assertEquals(body.data.kind, "invite");
    assertEquals(typeof body.data.subject, "string");
    assertStringIncludes(body.data.html, "<!doctype html>");
  } finally {
    restore();
    await ctx.cleanup();
  }
});

dbTest("preview: an unregistered kind is a clean 404", async () => {
  const restore = setDevRoutes(null);
  const ctx = await createIsolatedUser("owner");
  try {
    const app = buildApp();
    const cookie = await cookieFor({ ...ctx.user, role: "owner" });
    const res = await app.request("/api/email/kinds/not-a-kind/preview", {
      headers: { cookie },
    });
    assertEquals(res.status, 404);
  } finally {
    restore();
    await ctx.cleanup();
  }
});

// ── Test send ─────────────────────────────────────────────────────────────

dbTest("test send: admin-only, and NOT relaxed by the dev flag", async () => {
  const restore = setDevRoutes("1");
  const ctx = await createIsolatedUser("viewer");
  try {
    const app = buildApp();
    const cookie = await cookieFor({ ...ctx.user, role: "viewer" });
    const res = await app.request("/api/email/test", {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ kind: "otp" }),
    });
    // Reads relax under the dev flag; a real delivery never does.
    assertEquals(res.status, 403);
  } finally {
    restore();
    await ctx.cleanup();
  }
});

dbTest("test send: defaults to the requester and marks the subject [TEST]", async () => {
  const ctx = await createIsolatedUser("owner");
  try {
    clearCapturedEmails();
    const app = buildApp();
    const cookie = await cookieFor({ ...ctx.user, role: "owner" });

    const res = await app.request("/api/email/test", {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ kind: "expiration_digest" }),
    });
    assertEquals(res.status, 200);
    const body = await res.json();
    assertEquals(body.data.to, ctx.user.email);

    const captured = lastCapturedEmail({ kind: "expiration_digest" });
    assertEquals(captured?.to, ctx.user.email);
    assertStringIncludes(captured?.subject ?? "", TEST_EMAIL_SUBJECT_PREFIX);
  } finally {
    clearCapturedEmails();
    await ctx.cleanup();
  }
});

dbTest("test send: an unregistered kind is a 404 and sends nothing", async () => {
  const ctx = await createIsolatedUser("owner");
  try {
    clearCapturedEmails();
    const app = buildApp();
    const cookie = await cookieFor({ ...ctx.user, role: "owner" });
    const res = await app.request("/api/email/test", {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ kind: "not-a-kind", to: "nobody@test.local" }),
    });
    assertEquals(res.status, 404);
    assertEquals(lastCapturedEmail({ to: "nobody@test.local" }), null);
  } finally {
    clearCapturedEmails();
    await ctx.cleanup();
  }
});

// ── Settings ──────────────────────────────────────────────────────────────

dbTest("settings: GET reports both switches and the effective result", async () => {
  const ctx = await createIsolatedUser("owner");
  try {
    const app = buildApp();
    const cookie = await cookieFor({ ...ctx.user, role: "owner" });
    const body = await (await app.request("/api/email/settings", { headers: { cookie } }))
      .json();

    assertEquals(body.data.orgCommunicationsEnabled, true);
    assertEquals(body.data.userCommunicationsEnabled, true);
    assertEquals(body.data.effectiveCommunicationsEnabled, true);
    assertEquals(body.data.canManageOrgSetting, true);
  } finally {
    await ctx.cleanup();
  }
});

dbTest("settings: the ORG switch is admin-gated; the PERSONAL one is not", async () => {
  const ctx = await createIsolatedUser("viewer");
  try {
    const app = buildApp();
    const cookie = await cookieFor({ ...ctx.user, role: "viewer" });

    const org = await app.request("/api/email/settings/org", {
      method: "PATCH",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ communicationsEnabled: false }),
    });
    assertEquals(org.status, 403);
    assertEquals(await getOrgCommunicationsEnabled(ctx.org.id), true);

    const me = await app.request("/api/email/settings/me", {
      method: "PATCH",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ communicationsEnabled: false }),
    });
    assertEquals(me.status, 200);
    assertEquals(await getUserCommunicationsEnabled(ctx.user.id), false);
  } finally {
    await ctx.cleanup();
  }
});

dbTest("settings: an admin can flip the org switch, and it persists", async () => {
  const ctx = await createIsolatedUser("owner");
  try {
    const app = buildApp();
    const cookie = await cookieFor({ ...ctx.user, role: "owner" });

    const res = await app.request("/api/email/settings/org", {
      method: "PATCH",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ communicationsEnabled: false }),
    });
    assertEquals(res.status, 200);
    assertEquals((await res.json()).data.orgCommunicationsEnabled, false);
    assertEquals(await getOrgCommunicationsEnabled(ctx.org.id), false);
  } finally {
    await ctx.cleanup();
  }
});

dbTest("settings: a non-boolean toggle is a readable 400", async () => {
  const ctx = await createIsolatedUser("owner");
  try {
    const app = buildApp();
    const cookie = await cookieFor({ ...ctx.user, role: "owner" });
    const res = await app.request("/api/email/settings/org", {
      method: "PATCH",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ communicationsEnabled: "nope" }),
    });
    assertEquals(res.status, 400);
    const body = await res.json();
    assertEquals(typeof body.error, "string");
  } finally {
    await ctx.cleanup();
  }
});
