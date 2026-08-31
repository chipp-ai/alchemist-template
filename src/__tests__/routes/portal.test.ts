/**
 * /api/portal -- the end-user lane's HTTP surface.
 *
 * What the routes must guarantee, beyond what the service tests cover:
 *
 *   - claim is PUBLIC and mints a session cookie (the emailed token is
 *     the credential, exactly like the invite magic link)
 *   - claim is POST-only, so an email client's link prefetch cannot sign
 *     anyone in
 *   - issuing, re-sending, and revoking are admin-gated
 *   - /me is self-scoped: a portal user cannot read anyone else's record
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import { createIsolatedUser, withTestServer } from "../helpers.ts";
import { createSessionToken } from "@/api/middleware/auth.ts";
import { portalRoutes } from "@/api/routes/portal/index.ts";
import { db } from "@/db/client.ts";
import { clearCapturedEmails, lastCapturedEmail } from "@/services/email.ts";

const HAS_DB = !!(Deno.env.get("TEST_DATABASE_URL") || Deno.env.get("DATABASE_URL"));

function dbTest(name: string, fn: () => Promise<void>) {
  Deno.test({ name, ignore: !HAS_DB, sanitizeResources: false, sanitizeOps: false, fn });
}

function buildApp() {
  return withTestServer((app) => {
    app.route("/api/portal", portalRoutes);
  });
}

async function cookieFor(user: {
  id: string;
  email: string;
  name: string | null;
  organizationId: string;
  role: string;
}): Promise<string> {
  return `session_id=${await createSessionToken(user)}`;
}

let counter = 0;
function uniqueEmail(prefix: string): string {
  counter++;
  return `${prefix}-${Date.now().toString(36)}-${counter}@portal-route.test.local`;
}

async function deleteUsers(emails: string[]): Promise<void> {
  if (emails.length === 0) return;
  await db.deleteFrom("users").where("email", "in", emails).execute();
}

function postJson(app: ReturnType<typeof buildApp>, url: string, body: unknown, cookie?: string) {
  return app.request(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(cookie ? { cookie } : {}),
    },
    body: JSON.stringify(body),
  });
}

// ── Admin gating ──────────────────────────────────────────────────────────

dbTest("issue: unauthenticated is 401, a viewer is 403", async () => {
  const viewer = await createIsolatedUser("viewer");
  try {
    const app = buildApp();
    const payload = { email: "nobody@portal-route.test.local", subjectType: "e", subjectId: "1" };

    assertEquals((await postJson(app, "/api/portal/tokens", payload)).status, 401);

    const cookie = await cookieFor({ ...viewer.user, role: "viewer" });
    assertEquals((await postJson(app, "/api/portal/tokens", payload, cookie)).status, 403);
  } finally {
    await viewer.cleanup();
  }
});

dbTest("issue: an admin mints a link, and the URL comes back exactly once", async () => {
  const ctx = await createIsolatedUser("owner");
  const email = uniqueEmail("issued");
  try {
    clearCapturedEmails();
    const app = buildApp();
    const cookie = await cookieFor({ ...ctx.user, role: "owner" });

    const res = await postJson(app, "/api/portal/tokens", {
      email,
      subjectType: "employee",
      subjectId: "emp-100",
      subjectLabel: "Jordan Ellis",
    }, cookie);

    assertEquals(res.status, 201);
    const body = await res.json();
    assertStringIncludes(body.data.url, "/#/portal/claim/");
    assertEquals(body.data.provisionedUser, true);
    assertEquals(body.data.access.subjectId, "emp-100");

    // The same link is in the recipient's mail, which is how an admin
    // answers "did it actually go out".
    assertStringIncludes(lastCapturedEmail({ kind: "portal_link" })?.text ?? "", body.data.url);

    const list = await (await app.request("/api/portal/tokens", { headers: { cookie } })).json();
    assertEquals(list.data.length, 1);
    // The listing never echoes a token or a URL.
    assertEquals("token" in list.data[0], false);
    assertEquals("url" in list.data[0], false);
  } finally {
    clearCapturedEmails();
    await ctx.cleanup();
    await deleteUsers([email]);
  }
});

dbTest("issue: a malformed address is a readable 400", async () => {
  const ctx = await createIsolatedUser("owner");
  try {
    const app = buildApp();
    const cookie = await cookieFor({ ...ctx.user, role: "owner" });
    const res = await postJson(app, "/api/portal/tokens", {
      email: "not-an-address",
      subjectType: "employee",
      subjectId: "emp-101",
    }, cookie);
    assertEquals(res.status, 400);
    assertEquals(typeof (await res.json()).error, "string");
  } finally {
    await ctx.cleanup();
  }
});

// ── Claim ─────────────────────────────────────────────────────────────────

dbTest("claim: is public, POST-only, and mints a session cookie", async () => {
  const ctx = await createIsolatedUser("owner");
  const email = uniqueEmail("claim");
  try {
    clearCapturedEmails();
    const app = buildApp();
    const cookie = await cookieFor({ ...ctx.user, role: "owner" });

    const issued = await (await postJson(app, "/api/portal/tokens", {
      email,
      subjectType: "employee",
      subjectId: "emp-102",
    }, cookie)).json();
    const token = issued.data.url.split("/#/portal/claim/")[1];

    // A GET must not consume or claim anything: an email client's
    // prefetch would otherwise sign a stranger in.
    assertEquals(
      (await app.request(`/api/portal/claim?token=${token}`)).status,
      404,
    );

    // No session cookie on the request: the token IS the credential.
    const res = await postJson(app, "/api/portal/claim", { token });
    assertEquals(res.status, 200);
    const setCookie = res.headers.get("set-cookie") ?? "";
    assertStringIncludes(setCookie, "session_id=");
    assertStringIncludes(setCookie, "HttpOnly");

    const body = await res.json();
    assertEquals(body.data.user.email, email);
    assertEquals(body.data.subject.id, "emp-102");
  } finally {
    clearCapturedEmails();
    await ctx.cleanup();
    await deleteUsers([email]);
  }
});

dbTest("claim: a bogus token is a 404 with no cookie", async () => {
  const app = buildApp();
  const res = await postJson(app, "/api/portal/claim", { token: "definitely-not-a-token" });
  assertEquals(res.status, 404);
  assertEquals(res.headers.get("set-cookie"), null);
});

dbTest("claim: an empty token is a 400, not a 500", async () => {
  const app = buildApp();
  assertEquals((await postJson(app, "/api/portal/claim", { token: "" })).status, 400);
  assertEquals((await postJson(app, "/api/portal/claim", {})).status, 400);
});

// ── /me ───────────────────────────────────────────────────────────────────

dbTest("me: returns the caller's own bindings and nothing else", async () => {
  const ctx = await createIsolatedUser("owner");
  const mine = uniqueEmail("me-mine");
  const theirs = uniqueEmail("me-theirs");
  try {
    clearCapturedEmails();
    const app = buildApp();
    const adminCookie = await cookieFor({ ...ctx.user, role: "owner" });

    const issued = await (await postJson(app, "/api/portal/tokens", {
      email: mine,
      subjectType: "employee",
      subjectId: "emp-200",
    }, adminCookie)).json();
    await postJson(app, "/api/portal/tokens", {
      email: theirs,
      subjectType: "employee",
      subjectId: "emp-201",
    }, adminCookie);

    const portalUser = await db
      .selectFrom("users")
      .select(["id", "email", "name", "role", "organizationId"])
      .where("email", "=", mine)
      .executeTakeFirstOrThrow();

    const portalCookie = await cookieFor({
      id: portalUser.id,
      email: portalUser.email,
      name: portalUser.name,
      organizationId: portalUser.organizationId as string,
      role: portalUser.role,
    });

    const res = await app.request("/api/portal/me", { headers: { cookie: portalCookie } });
    assertEquals(res.status, 200);
    const body = await res.json();
    assertEquals(body.data.user.role, "viewer");
    assertEquals(body.data.subjects.length, 1);
    assertEquals(body.data.subjects[0].subjectId, "emp-200");
    assertEquals(body.data.subjects[0].id, issued.data.access.id);

    // The portal user cannot reach the admin surface.
    assertEquals(
      (await app.request("/api/portal/tokens", { headers: { cookie: portalCookie } })).status,
      403,
    );
  } finally {
    clearCapturedEmails();
    await ctx.cleanup();
    await deleteUsers([mine, theirs]);
  }
});

dbTest("me: unauthenticated is 401", async () => {
  const app = buildApp();
  assertEquals((await app.request("/api/portal/me")).status, 401);
});

// ── Resend + revoke ───────────────────────────────────────────────────────

dbTest("resend: admin-gated, needs no body, and retires the old link", async () => {
  const ctx = await createIsolatedUser("owner");
  const email = uniqueEmail("resend");
  try {
    clearCapturedEmails();
    const app = buildApp();
    const cookie = await cookieFor({ ...ctx.user, role: "owner" });

    const first = await (await postJson(app, "/api/portal/tokens", {
      email,
      subjectType: "employee",
      subjectId: "emp-300",
    }, cookie)).json();
    const firstToken = first.data.url.split("/#/portal/claim/")[1];

    // No JSON body at all: a resend button must not 400 over that.
    const res = await app.request(`/api/portal/tokens/${first.data.access.id}/resend`, {
      method: "POST",
      headers: { cookie },
    });
    assertEquals(res.status, 200);
    const body = await res.json();
    assertEquals(body.data.replacedPrevious, true);

    const newToken = body.data.url.split("/#/portal/claim/")[1];
    assertEquals(newToken === firstToken, false);
    assertEquals((await postJson(app, "/api/portal/claim", { token: firstToken })).status, 404);
    assertEquals((await postJson(app, "/api/portal/claim", { token: newToken })).status, 200);
  } finally {
    clearCapturedEmails();
    await ctx.cleanup();
    await deleteUsers([email]);
  }
});

dbTest("revoke: admin-gated, idempotent, and the link stops working", async () => {
  const ctx = await createIsolatedUser("owner");
  const viewer = await createIsolatedUser("viewer");
  const email = uniqueEmail("revoke");
  try {
    clearCapturedEmails();
    const app = buildApp();
    const cookie = await cookieFor({ ...ctx.user, role: "owner" });

    const issued = await (await postJson(app, "/api/portal/tokens", {
      email,
      subjectType: "employee",
      subjectId: "emp-400",
    }, cookie)).json();
    const token = issued.data.url.split("/#/portal/claim/")[1];
    const id = issued.data.access.id;

    const viewerCookie = await cookieFor({ ...viewer.user, role: "viewer" });
    assertEquals(
      (await app.request(`/api/portal/tokens/${id}`, {
        method: "DELETE",
        headers: { cookie: viewerCookie },
      })).status,
      403,
    );

    const del = await app.request(`/api/portal/tokens/${id}`, {
      method: "DELETE",
      headers: { cookie },
    });
    assertEquals(del.status, 200);
    assertEquals((await postJson(app, "/api/portal/claim", { token })).status, 404);

    // Revoking again is a no-op, not an error.
    assertEquals(
      (await app.request(`/api/portal/tokens/${id}`, {
        method: "DELETE",
        headers: { cookie },
      })).status,
      200,
    );
  } finally {
    clearCapturedEmails();
    await ctx.cleanup();
    await viewer.cleanup();
    await deleteUsers([email]);
  }
});
