/**
 * Route tests for POST /api/ingest/email (Postmark inbound webhook).
 *
 * Covers the token gate (fail-closed unset, wrong token, query-param
 * accept) and capture semantics (201 create, 200 dedup with the same id,
 * synthetic message id when the payload carries no identifiers).
 *
 * NOTE: rows here are captured with organization_id NULL (INGEST_ORG_ID
 * is not set in the suite), so ctx.cleanup()-style org cascades do NOT
 * cover them -- every created inbound_email row is deleted explicitly in
 * a finally block (attachments cascade via FK).
 */

import { assertEquals, assertExists, assertNotEquals } from "@std/assert";
import { db } from "@/db/client.ts";
import { withTestServer } from "../helpers.ts";
import { ingestEmailRoutes } from "@/api/routes/ingest-email/index.ts";

const ROUTE = "/api/ingest/email";
const TEST_TOKEN = "test-ingest-token-1234567890";

function buildApp() {
  return withTestServer((app) => {
    app.route(ROUTE, ingestEmailRoutes);
  });
}

/** Save + set INGEST_EMAIL_TOKEN; returns a restore function for finally. */
function setToken(value: string | null): () => void {
  const prev = Deno.env.get("INGEST_EMAIL_TOKEN");
  if (value === null) {
    Deno.env.delete("INGEST_EMAIL_TOKEN");
  } else {
    Deno.env.set("INGEST_EMAIL_TOKEN", value);
  }
  return () => {
    if (prev === undefined) {
      Deno.env.delete("INGEST_EMAIL_TOKEN");
    } else {
      Deno.env.set("INGEST_EMAIL_TOKEN", prev);
    }
  };
}

function postJson(app: ReturnType<typeof buildApp>, url: string, body: unknown) {
  return app.request(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function deleteEmails(ids: (string | null | undefined)[]): Promise<void> {
  const real = ids.filter((i): i is string => typeof i === "string" && i.length > 0);
  if (real.length === 0) return;
  await db.deleteFrom("inbound_email").where("id", "in", real).execute();
}

Deno.test({
  name: "ingest-email: token unset -> 401 (fail closed)",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    const restore = setToken(null);
    try {
      const app = buildApp();
      const res = await postJson(app, `${ROUTE}?token=anything`, { Subject: "hi" });
      assertEquals(res.status, 401);
      const body = await res.json();
      assertEquals(body.code, "UNAUTHORIZED");
    } finally {
      restore();
    }
  },
});

Deno.test({
  name: "ingest-email: wrong token -> 401",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    const restore = setToken(TEST_TOKEN);
    try {
      const app = buildApp();
      // Wrong via query param
      const res1 = await postJson(app, `${ROUTE}?token=wrong-token`, { Subject: "hi" });
      assertEquals(res1.status, 401);
      // Wrong via bearer header
      const res2 = await app.request(ROUTE, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          Authorization: "Bearer also-wrong",
        },
        body: JSON.stringify({ Subject: "hi" }),
      });
      assertEquals(res2.status, 401);
      // No credential at all
      const res3 = await postJson(app, ROUTE, { Subject: "hi" });
      assertEquals(res3.status, 401);
    } finally {
      restore();
    }
  },
});

Deno.test({
  name: "ingest-email: valid token via query param -> 201 + row exists",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    const restore = setToken(TEST_TOKEN);
    let createdId: string | null = null;
    try {
      const app = buildApp();
      const messageId = `<route-test-${crypto.randomUUID()}@example.test>`;
      const res = await postJson(app, `${ROUTE}?token=${TEST_TOKEN}`, {
        From: "sender@example.test",
        To: "inbox@example.test",
        Subject: "Route capture test",
        TextBody: "hello world",
        MessageID: crypto.randomUUID(),
        Headers: [{ Name: "Message-ID", Value: messageId }],
      });
      assertEquals(res.status, 201);
      const body = await res.json();
      assertExists(body.data.id);
      assertEquals(body.data.deduplicated, false);
      createdId = body.data.id;

      const row = await db
        .selectFrom("inbound_email")
        .select(["id", "messageId", "subject", "status", "fromAddress", "headers"])
        .where("id", "=", createdId!)
        .executeTakeFirst();
      assertExists(row);
      // RFC Message-ID header wins the dedup ladder.
      assertEquals(row!.messageId, messageId);
      assertEquals(row!.subject, "Route capture test");
      assertEquals(row!.status, "received");
      assertEquals(row!.fromAddress, "sender@example.test");
      // JSONB headers round-trip as a structured array, not a string.
      assertEquals(row!.headers, [{ Name: "Message-ID", Value: messageId }]);
    } finally {
      await deleteEmails([createdId]);
      restore();
    }
  },
});

Deno.test({
  name: "ingest-email: repost same MessageID -> 200 deduplicated + same id",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    const restore = setToken(TEST_TOKEN);
    let createdId: string | null = null;
    try {
      const app = buildApp();
      const payload = {
        From: "sender@example.test",
        Subject: "Dedup test",
        TextBody: "same message twice",
        MessageID: crypto.randomUUID(),
      };
      const res1 = await postJson(app, `${ROUTE}?token=${TEST_TOKEN}`, payload);
      assertEquals(res1.status, 201);
      const body1 = await res1.json();
      createdId = body1.data.id;
      assertEquals(body1.data.deduplicated, false);

      const res2 = await postJson(app, `${ROUTE}?token=${TEST_TOKEN}`, payload);
      assertEquals(res2.status, 200);
      const body2 = await res2.json();
      assertEquals(body2.data.deduplicated, true);
      assertEquals(body2.data.id, createdId);

      // Exactly one row exists for this message.
      const rows = await db
        .selectFrom("inbound_email")
        .select("id")
        .where("id", "=", createdId!)
        .execute();
      assertEquals(rows.length, 1);
    } finally {
      await deleteEmails([createdId]);
      restore();
    }
  },
});

Deno.test({
  name: "ingest-email: body missing everything still captures (synthetic id)",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    const restore = setToken(TEST_TOKEN);
    let firstId: string | null = null;
    let secondId: string | null = null;
    try {
      const app = buildApp();
      // No MessageID, no Message-ID header -- but distinct content so the
      // synthetic hash is unique to this test run.
      const payload = { TextBody: `synthetic-only ${crypto.randomUUID()}` };
      const res = await postJson(app, `${ROUTE}?token=${TEST_TOKEN}`, payload);
      assertEquals(res.status, 201);
      const body = await res.json();
      assertExists(body.data.id);
      firstId = body.data.id;

      const row = await db
        .selectFrom("inbound_email")
        .select(["messageId", "status"])
        .where("id", "=", firstId!)
        .executeTakeFirst();
      assertExists(row);
      assertEquals(row!.messageId.startsWith("synthetic:"), true);
      assertEquals(row!.status, "received");

      // A retry of the identical no-id payload dedups against itself...
      const resRetry = await postJson(app, `${ROUTE}?token=${TEST_TOKEN}`, payload);
      assertEquals(resRetry.status, 200);
      assertEquals((await resRetry.json()).data.id, firstId);

      // ...while different content produces a different synthetic row.
      const res2 = await postJson(app, `${ROUTE}?token=${TEST_TOKEN}`, {
        TextBody: `different content ${crypto.randomUUID()}`,
      });
      assertEquals(res2.status, 201);
      secondId = (await res2.json()).data.id;
      assertNotEquals(secondId, firstId);
    } finally {
      await deleteEmails([firstId, secondId]);
      restore();
    }
  },
});
