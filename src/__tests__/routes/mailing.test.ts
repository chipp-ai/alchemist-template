/**
 * Mailing lists through the real routes:
 *
 *   - the contacts import refuses to commit until the importer says where
 *     the list came from and attests opt-in, stores that statement, and
 *     skips typos, test addresses, suppressed addresses and duplicates
 *     with reasons
 *   - a campaign send on the shared platform sender answers 409
 *     SENDER_DOMAIN_REQUIRED with the fix
 *   - one-click unsubscribe: GET never unsubscribes, POST does
 *   - provider feedback: fail-closed token, and a hard bounce suppresses
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  createIsolatedUser,
  dbTest,
  getTestDb,
  utf8Bytes,
  withLocalStorage,
  withTestServer,
} from "../helpers.ts";
import { createSessionToken } from "@/api/middleware/auth.ts";
import { importRoutes } from "@/api/routes/imports/index.ts";
import { mailingRoutes } from "@/api/routes/mailing/index.ts";
import { unsubscribeRoutes } from "@/api/routes/unsubscribe/index.ts";
import { emailFeedbackRoutes } from "@/api/routes/email-feedback/index.ts";
import {
  _internalsForTest as senderSeam,
  CONTACTS_IMPORT_NAME,
  registerContactsImport,
  signUnsubscribeToken,
} from "@/services/mailing/index.ts";
import { __deleteEnvForTest, __setEnvForTest } from "@/lib/env.ts";

const db = getTestDb();

const app = withTestServer((a) => {
  a.route("/api/imports", importRoutes);
  a.route("/api/mailing", mailingRoutes);
  a.route("/api/unsubscribe", unsubscribeRoutes);
  a.route("/api/email-feedback", emailFeedbackRoutes);
});

const run = crypto.randomUUID().slice(0, 8);
const domain = `list-${run}.com`;

async function signIn(role: "owner" | "admin" | "editor" | "viewer" = "owner") {
  const { user, org, cleanup } = await createIsolatedUser(role);
  const token = await createSessionToken({
    id: user.id,
    email: user.email,
    name: user.name,
    organizationId: user.organizationId,
    role: user.role,
  });
  return { user, org, cookie: `session_id=${token}`, cleanup };
}

type Person = Awaited<ReturnType<typeof signIn>>;

async function postJson(p: Person, path: string, body?: unknown) {
  return await app.request(path, {
    method: "POST",
    headers: {
      cookie: p.cookie,
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function upload(p: Person, csv: string) {
  const form = new FormData();
  form.set("file", new File([utf8Bytes(csv)], "kajabi-export.csv", { type: "text/csv" }));
  form.set("definition", CONTACTS_IMPORT_NAME);
  return await app.request(
    "/api/imports/sessions",
    {
      method: "POST",
      headers: { cookie: p.cookie },
      body: form,
    } as unknown as Parameters<typeof app.request>[1],
  );
}

const KAJABI_ATTESTATION = {
  listSource: "previous_platform",
  listSourceDetail: "Kajabi export, October 2026",
  optedIn: true,
};

dbTest("contacts import: attestation required, stored, and hygiene applied", async () => {
  registerContactsImport();
  const owner = await signIn("owner");
  try {
    // An address that already bounced elsewhere in the app.
    const bounced = `gone.${run}@${domain}`;
    await db.insertInto("email_suppressions").values({ email: bounced, reason: "hard_bounce" })
      .execute();

    await withLocalStorage(async () => {
      const csv = [
        "Email,Name",
        `ada.${run}@${domain},Ada Lovelace`,
        `ADA.${run}@${domain},Ada Again`, // duplicate inside the file
        `pat.${run}@gmail.co,Pat Typo`,
        `probe@${domain},Probe`,
        `not-an-email,Nobody`,
        `${bounced},Gone`,
        `grace.${run}@${domain},Grace Hopper`,
      ].join("\n");
      const res = await upload(owner, csv);
      assertEquals(res.status, 201, await res.clone().text());
      const sessionId = (await res.json()).data.session.id;

      const preview = (await (await app.request(`/api/imports/sessions/${sessionId}/preview`, {
        headers: { cookie: owner.cookie },
      })).json()).data;
      assertEquals(preview.counts.create, 2);
      assertEquals(preview.counts.duplicate, 1);
      assertEquals(preview.counts.invalid, 4);
      const reasons = preview.problemRows.map((r: { reason: string }) => r.reason).join(" | ");
      assertStringIncludes(reasons, "gmail.com");
      assertStringIncludes(reasons, "test or system address");
      assertStringIncludes(reasons, "suppressed (hard bounce)");

      // No attestation: refused, nothing written.
      let commit = await postJson(owner, `/api/imports/sessions/${sessionId}/commit`);
      assertEquals(commit.status, 400);
      assertStringIncludes((await commit.json()).error, "where this list came from");

      // External source without saying where: refused.
      commit = await postJson(owner, `/api/imports/sessions/${sessionId}/commit`, {
        attestation: { listSource: "previous_platform", optedIn: true },
      });
      assertEquals(commit.status, 400);

      // Not confirming opt-in: refused.
      commit = await postJson(owner, `/api/imports/sessions/${sessionId}/commit`, {
        attestation: { ...KAJABI_ATTESTATION, optedIn: false },
      });
      assertEquals(commit.status, 400);
      const none = await db.selectFrom("email_contacts").select(["id"])
        .where("organizationId", "=", owner.org.id).execute();
      assertEquals(none.length, 0);

      commit = await postJson(owner, `/api/imports/sessions/${sessionId}/commit`, {
        attestation: KAJABI_ATTESTATION,
      });
      assertEquals(commit.status, 200, await commit.clone().text());
      const body = (await commit.json()).data;
      assertEquals(body.result.created, 2);
      assertEquals(body.session.attestation.listSource, "previous_platform");
      assertEquals(body.session.attestation.collectedInApp, false);
      assertEquals(body.session.attestation.attestedBy, owner.user.id);

      const contacts = await db.selectFrom("email_contacts").selectAll()
        .where("organizationId", "=", owner.org.id).orderBy("email").execute();
      assertEquals(contacts.map((c) => c.email), [
        `ada.${run}@${domain}`,
        `grace.${run}@${domain}`,
      ]);
      for (const c of contacts) {
        assertEquals(c.origin, "import");
        assertEquals(c.consentSource, "previous_platform");
        assertEquals(c.consentSourceDetail, "Kajabi export, October 2026");
        assertEquals(c.consentCollectedInApp, false);
        assertEquals(c.consentAttestedBy, owner.user.id);
        assertEquals(c.importSessionId, sessionId);
        assertEquals(c.firstSentAt, null);
      }

      // A re-import never re-subscribes someone who left.
      await db.updateTable("email_contacts").set({ status: "unsubscribed" })
        .where("email", "=", `ada.${run}@${domain}`).execute();
      const again = await upload(owner, `Email,Name\nada.${run}@${domain},Ada L\n`);
      const againId = (await again.json()).data.session.id;
      const res2 = await postJson(owner, `/api/imports/sessions/${againId}/commit`, {
        attestation: { listSource: "app_signup", optedIn: true },
      });
      assertEquals((await res2.json()).data.result.updated, 1);
      const ada = await db.selectFrom("email_contacts").select(["status", "firstName"])
        .where("email", "=", `ada.${run}@${domain}`).executeTakeFirstOrThrow();
      assertEquals(ada.status, "unsubscribed");
      assertEquals(ada.firstName, "Ada");
    });
  } finally {
    await owner.cleanup();
  }
});

dbTest("contacts import: an editor may not import a mailing list", async () => {
  registerContactsImport();
  const editor = await signIn("editor");
  try {
    await withLocalStorage(async () => {
      const res = await upload(editor, `Email\nx.${run}@${domain}\n`);
      assertEquals(res.status, 403);
    });
    const r = await app.request("/api/mailing/campaigns", { headers: { cookie: editor.cookie } });
    assertEquals(r.status, 403);
  } finally {
    await editor.cleanup();
  }
});

dbTest("campaign send on the shared sender: 409 SENDER_DOMAIN_REQUIRED with the fix", async () => {
  const owner = await signIn("owner");
  const original = senderSeam.inputs;
  senderSeam.inputs = () => ({
    fromEmail: "noreply@chipp.ai",
    platformEmailFrom: "noreply@chipp.ai",
    smtpConfigured: true,
  });
  try {
    await db.insertInto("email_contacts")
      .values({ organizationId: owner.org.id, email: `fan.${run}@${domain}`, origin: "signup" })
      .execute();
    const created = await postJson(owner, "/api/mailing/campaigns", {
      name: "November",
      subject: "News",
      text: "Hello",
    });
    assertEquals(created.status, 201);
    const id = (await created.json()).data.id;

    const res = await postJson(owner, `/api/mailing/campaigns/${id}/send`);
    assertEquals(res.status, 409);
    const body = await res.json();
    assertEquals(body.code, "SENDER_DOMAIN_REQUIRED");
    assertStringIncludes(body.error, "shared by every app");

    const readiness = (await (await app.request("/api/mailing/readiness", {
      headers: { cookie: owner.cookie },
    })).json()).data;
    assertEquals(readiness.sender.allowed, false);
    assertEquals(readiness.sender.code, "shared_platform_sender");
    assertEquals(typeof readiness.feedbackConnected, "boolean");

    // With a verified domain the same campaign goes.
    senderSeam.inputs = () => ({
      fromEmail: "news@mail.yourbrand.com",
      platformEmailFrom: "noreply@chipp.ai",
      smtpConfigured: true,
    });
    const ok = await postJson(owner, `/api/mailing/campaigns/${id}/send`);
    assertEquals(ok.status, 200, await ok.clone().text());
    assertEquals((await ok.json()).data.status, "sending");
  } finally {
    senderSeam.inputs = original;
    await owner.cleanup();
  }
});

dbTest("unsubscribe: GET shows a button and changes nothing; POST unsubscribes", async () => {
  const owner = await signIn("owner");
  try {
    const email = `reader.${run}@${domain}`;
    await db.insertInto("email_contacts")
      .values({ organizationId: owner.org.id, email, origin: "signup" })
      .execute();
    const token = signUnsubscribeToken({ email, organizationId: owner.org.id });

    const page = await app.request(`/api/unsubscribe/${token}`);
    assertEquals(page.status, 200);
    const html = await page.text();
    assertStringIncludes(html, `method="post"`);
    assertStringIncludes(html, email);
    let row = await db.selectFrom("email_contacts").select(["status"]).where("email", "=", email)
      .executeTakeFirstOrThrow();
    assertEquals(row.status, "subscribed");

    // What Gmail's button sends (RFC 8058).
    const post = await app.request(`/api/unsubscribe/${token}`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "List-Unsubscribe=One-Click",
    });
    assertEquals(post.status, 200);
    row = await db.selectFrom("email_contacts").select(["status"]).where("email", "=", email)
      .executeTakeFirstOrThrow();
    assertEquals(row.status, "unsubscribed");

    const forged = await app.request(`/api/unsubscribe/${token.slice(0, -3)}xyz`, {
      method: "POST",
    });
    assertEquals(forged.status, 404);
  } finally {
    await owner.cleanup();
  }
});

dbTest("feedback: fail closed without a token; a hard bounce suppresses", async () => {
  const email = `bounce.${run}@${domain}`;
  const body = JSON.stringify({
    events: [{ type: "hard_bounce", email, detail: "550 5.1.1 user unknown" }],
  });
  const send = (auth?: string) =>
    app.request("/api/email-feedback", {
      method: "POST",
      headers: { "content-type": "application/json", ...(auth ? { authorization: auth } : {}) },
      body,
    });

  __deleteEnvForTest("EMAIL_FEEDBACK_TOKEN");
  assertEquals((await send("Bearer anything")).status, 401);

  __setEnvForTest("EMAIL_FEEDBACK_TOKEN", `tok-${run}`);
  try {
    assertEquals((await send()).status, 401);
    assertEquals((await send("Bearer wrong")).status, 401);
    const ok = await send(`Bearer tok-${run}`);
    assertEquals(ok.status, 200, await ok.clone().text());
    const result = (await ok.json()).data.results[0];
    assertEquals(result.action, "suppressed");
    const row = await db.selectFrom("email_suppressions").selectAll().where("email", "=", email)
      .executeTakeFirstOrThrow();
    assertEquals(row.reason, "hard_bounce");
    assertEquals(row.organizationId, null);
    assert(row.detail?.includes("user unknown"));

    const bad = await app.request("/api/email-feedback", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer tok-${run}` },
      body: JSON.stringify({ events: [{ type: "explode", email }] }),
    });
    assertEquals(bad.status, 400);
  } finally {
    __deleteEnvForTest("EMAIL_FEEDBACK_TOKEN");
  }
});
