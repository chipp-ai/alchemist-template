/**
 * Route tests for POST /api/events/inbox.
 *
 * Covers the HMAC gate (secret unset fails closed, bad signature, stale
 * timestamp), idempotency on the sender's event id (201 once, 200 for
 * the duplicate with nothing written), the deployment-scope rule (an
 * organizationId in the body is dropped, never stored) and input shape
 * (bad topic, bad source, non-object payload).
 *
 * Rows land with organization_id NULL, so every event is deleted by id
 * in a finally block.
 */

import { assert, assertEquals } from "@std/assert";
import { db } from "@/db/client.ts";
import { withTestServer } from "../helpers.ts";
import { eventsRoutes } from "@/api/routes/events/index.ts";
import {
  EVENT_SIGNATURE_HEADER,
  EVENT_TIMESTAMP_HEADER,
  signEventBody,
} from "@/lib/event-signing.ts";
import { uuidv7 } from "@/lib/uuidv7.ts";

const HAS_DB = !!(Deno.env.get("TEST_DATABASE_URL") || Deno.env.get("DATABASE_URL"));
const ROUTE = "/api/events";
const SECRET = "inbox-test-secret-0123456789";

function dbTest(name: string, fn: () => Promise<void>) {
  Deno.test({ name, ignore: !HAS_DB, sanitizeResources: false, sanitizeOps: false, fn });
}

function buildApp() {
  return withTestServer((app) => {
    app.route(ROUTE, eventsRoutes);
  });
}

function setSecret(value: string | null): () => void {
  const prev = Deno.env.get("EVENTS_INBOX_SECRET");
  if (value === null) Deno.env.delete("EVENTS_INBOX_SECRET");
  else Deno.env.set("EVENTS_INBOX_SECRET", value);
  return () => {
    if (prev === undefined) Deno.env.delete("EVENTS_INBOX_SECRET");
    else Deno.env.set("EVENTS_INBOX_SECRET", prev);
  };
}

interface SendOptions {
  secret?: string;
  timestamp?: number;
  signature?: string;
  omitSignature?: boolean;
}

function send(app: ReturnType<typeof buildApp>, body: unknown, opts: SendOptions = {}) {
  const raw = typeof body === "string" ? body : JSON.stringify(body);
  const ts = opts.timestamp ?? Math.floor(Date.now() / 1_000);
  const headers: Record<string, string> = {
    "content-type": "application/json",
    [EVENT_TIMESTAMP_HEADER]: String(ts),
  };
  if (!opts.omitSignature) {
    headers[EVENT_SIGNATURE_HEADER] = opts.signature ??
      signEventBody(opts.secret ?? SECRET, ts, raw);
  }
  return app.request(`${ROUTE}/inbox`, { method: "POST", headers, body: raw });
}

async function deleteEvents(ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  await db.deleteFrom("events").where("id", "in", ids).execute();
}

Deno.test("events inbox: secret unset -> 401 (fail closed)", async () => {
  const restore = setSecret(null);
  try {
    const res = await send(buildApp(), { id: uuidv7(), topic: "a.b", source: "platform" });
    assertEquals(res.status, 401);
  } finally {
    restore();
  }
});

Deno.test("events inbox: a bad signature is rejected", async () => {
  const restore = setSecret(SECRET);
  try {
    const app = buildApp();
    const body = { id: uuidv7(), topic: "deploy.finished", source: "platform" };
    assertEquals((await send(app, body, { secret: "wrong" })).status, 401);
    assertEquals((await send(app, body, { omitSignature: true })).status, 401);
    assertEquals((await send(app, body, { signature: "v1=" + "f".repeat(64) })).status, 401);
    // Signed body and sent body differ by one byte.
    const ts = Math.floor(Date.now() / 1_000);
    const sig = signEventBody(SECRET, ts, JSON.stringify(body));
    assertEquals(
      (await send(app, JSON.stringify(body) + " ", { timestamp: ts, signature: sig })).status,
      401,
    );
  } finally {
    restore();
  }
});

Deno.test("events inbox: a stale timestamp is rejected even with a valid signature", async () => {
  const restore = setSecret(SECRET);
  try {
    const app = buildApp();
    const body = { id: uuidv7(), topic: "deploy.finished", source: "platform" };
    const old = Math.floor(Date.now() / 1_000) - 6 * 60;
    assertEquals((await send(app, body, { timestamp: old })).status, 401);
    const future = Math.floor(Date.now() / 1_000) + 6 * 60;
    assertEquals((await send(app, body, { timestamp: future })).status, 401);
  } finally {
    restore();
  }
});

dbTest("events inbox: accepts a valid delivery once and ignores its duplicate", async () => {
  const restore = setSecret(SECRET);
  const app = buildApp();
  const id = uuidv7();
  try {
    const body = {
      id,
      topic: "credential.rotated",
      key: "stripe",
      payload: { provider: "stripe", rotatedAt: "2026-09-22T00:00:00Z" },
      source: "platform",
      // Never trusted: the inbox scopes to the deployment.
      organizationId: "00000000-0000-0000-0000-000000000001",
    };
    const first = await send(app, body);
    assertEquals(first.status, 201);
    assertEquals(await first.json(), { id, inserted: true, deliveries: 0 });

    const stored = await db.selectFrom("events").selectAll().where("id", "=", id)
      .executeTakeFirstOrThrow();
    assertEquals(stored.topic, "credential.rotated");
    assertEquals(stored.key, "stripe");
    assertEquals(stored.source, "platform");
    assertEquals(stored.organizationId, null, "the body's organizationId is dropped");
    assertEquals(stored.payload, { provider: "stripe", rotatedAt: "2026-09-22T00:00:00Z" });

    // The sender retries with a different payload: same id, nothing changes.
    const dup = await send(app, { ...body, payload: { provider: "changed" } });
    assertEquals(dup.status, 200);
    assertEquals(await dup.json(), { id, inserted: false, deliveries: 0 });
    const again = await db.selectFrom("events").select("payload").where("id", "=", id)
      .executeTakeFirstOrThrow();
    assertEquals(again.payload, { provider: "stripe", rotatedAt: "2026-09-22T00:00:00Z" });
    assertEquals(
      (await db.selectFrom("events").select("id").where("id", "=", id).execute()).length,
      1,
    );
  } finally {
    restore();
    await deleteEvents([id]);
  }
});

dbTest("events inbox: rejects a malformed event without writing", async () => {
  const restore = setSecret(SECRET);
  const app = buildApp();
  const ids: string[] = [];
  try {
    const ok = { id: uuidv7(), topic: "file.uploaded", source: "external" };
    ids.push(ok.id);
    const cases: [unknown, string][] = [
      [{ ...ok, id: "not-a-uuid" }, "id"],
      [{ ...ok, topic: "FileUploaded" }, "topic shape"],
      [{ ...ok, source: "app" }, "app is not an inbox source"],
      [{ ...ok, payload: [1, 2] }, "array payload"],
      [{ ...ok, payload: "str" }, "string payload"],
      ["{not json", "invalid json"],
    ];
    for (const [body, why] of cases) {
      const res = await send(app, body);
      assertEquals(res.status, 400, why);
    }
    const rows = await db.selectFrom("events").select("id").where("id", "=", ok.id).execute();
    assertEquals(rows.length, 0, "no malformed case reached the table");

    const res = await send(app, ok);
    assertEquals(res.status, 201);
    assert(((await res.json()) as { inserted: boolean }).inserted);
  } finally {
    restore();
    await deleteEvents(ids);
  }
});
