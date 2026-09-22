/**
 * Slice B of the event pipeline: the consumer loop, outbound webhooks,
 * the signing scheme and the retention sweep. DB cases run against the
 * real Postgres and are skipped without DATABASE_URL.
 *
 * What the cases pin:
 *
 *   - a Redis nudge (faked through the subscribe seam) runs a tick at
 *     once, long before the poll interval; the consumer runs the handler
 *     and marks the delivery done
 *   - a webhook delivery POSTs the event with a signature the receiver
 *     can verify by recomputing the HMAC (done here with node:crypto,
 *     not with the module under test), and a persistent 500 walks the
 *     same failed -> dead path as a handler
 *   - the URL validator refuses http, credentials, loopback, private,
 *     link-local, mapped-IPv4 and local hostnames
 *   - verifyEventSignature names each failure
 *   - the retention sweep deletes old done deliveries and old events
 *     (with their receipts) and leaves recent rows alone, and holds an
 *     old event whose delivery on an active subscription is unfinished
 *   - a nudge that lands during the boot sync coalesces into the first
 *     tick instead of starting a second loop
 *   - stopEventConsumer resolves only after the tick in flight wrote its
 *     outcome
 *   - with Redis present, a peer holding the tick lock stops this pod
 *     from draining, and releasing it lets the next tick drain
 */

import { assert, assertEquals, assertThrows } from "@std/assert";
import { createHmac } from "node:crypto";
import { createIsolatedUser, getTestDb } from "../helpers.ts";
import {
  _resetEventRegistryForTest,
  claimDeliveries,
  processDelivery,
  publishEvent,
  publishEventAndNudge,
  registerEventHandler,
  sweepEventRetention,
  syncSubscriptionsFromRegistry,
} from "@/lib/events.ts";
import { acquireLock, releaseLock } from "@/lib/redis.ts";
import {
  createWebhookSubscription,
  deactivateWebhookSubscription,
  EVENT_ATTEMPT_HEADER,
  EVENT_DELIVERY_HEADER,
  listWebhookSubscriptions,
  validateWebhookUrl,
} from "@/lib/event-webhooks.ts";
import {
  EVENT_ID_HEADER,
  EVENT_SIGNATURE_HEADER,
  EVENT_TIMESTAMP_HEADER,
  EVENT_TOPIC_HEADER,
  signEventBody,
  verifyEventSignature,
} from "@/lib/event-signing.ts";
import {
  __peekEventConsumerStateForTest,
  __resetEventConsumerForTest,
  startEventConsumer,
  stopEventConsumer,
  type SubscribeFn,
} from "@/jobs/event-consumer.ts";
import { redisSubscribe } from "@/lib/redis.ts";
import { sql } from "kysely";

const HAS_DB = !!(Deno.env.get("TEST_DATABASE_URL") || Deno.env.get("DATABASE_URL"));
const HAS_REDIS = !!Deno.env.get("REDIS_URL");

function dbTest(name: string, fn: () => Promise<void>) {
  Deno.test({ name, ignore: !HAS_DB, sanitizeResources: false, sanitizeOps: false, fn });
}

function dbRedisTest(name: string, fn: () => Promise<void>) {
  Deno.test({
    name,
    ignore: !HAS_DB || !HAS_REDIS,
    sanitizeResources: false,
    sanitizeOps: false,
    fn,
  });
}

/** A fake nudge channel: captures the consumer's callback so a test can wake it. */
function fakeChannel() {
  const captured: { nudge: ((message: string) => void) | null; closed: number } = {
    nudge: null,
    closed: 0,
  };
  const subscribe: SubscribeFn = (_channel, onMessage) => {
    captured.nudge = onMessage;
    return { close: () => captured.closed++ };
  };
  return { captured, subscribe };
}

const db = HAS_DB ? getTestDb() : null!;

let topicCounter = 0;
function uniqueTopic(): string {
  topicCounter++;
  return `testb.t${Date.now().toString(36)}${
    Math.random().toString(36).slice(2, 7)
  }${topicCounter}.happened`;
}

async function cleanupTopic(topic: string): Promise<void> {
  await db.deleteFrom("events").where("topic", "=", topic).execute();
  await db.deleteFrom("event_subscriptions").where("topic", "=", topic).execute();
}

async function deliveriesForTopic(topic: string) {
  return await db
    .selectFrom("event_deliveries as d")
    .innerJoin("events as e", "e.id", "d.eventId")
    .select(["d.id", "d.status", "d.attempts", "d.lastError"])
    .where("e.topic", "=", topic)
    .orderBy("d.id")
    .execute();
}

async function waitFor(pred: () => Promise<boolean>, ms: number, what: string): Promise<void> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (await pred()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`timed out waiting for ${what}`);
}

const noJitter = () => 0;

// ── consumer loop ──

dbTest("event consumer: a nudge runs a tick at once, runs the handler and marks done", async () => {
  _resetEventRegistryForTest();
  await __resetEventConsumerForTest();
  const topic = uniqueTopic();
  const seen: string[] = [];
  const captured: { nudge: ((message: string) => void) | null; closed: number } = {
    nudge: null,
    closed: 0,
  };
  const fakeSubscribe: SubscribeFn = (_channel, onMessage) => {
    captured.nudge = onMessage;
    return { close: () => captured.closed++ };
  };
  try {
    registerEventHandler(topic, (e) => {
      seen.push(e.key ?? "");
    }, { name: "record" });

    startEventConsumer({
      subscribe: fakeSubscribe,
      topics: [topic],
      runInTestEnv: true,
      pollIntervalMs: 60_000, // only a nudge can explain a second tick
    });
    // Boot: sync, then one tick that finds nothing.
    await waitFor(
      async () => {
        const s = __peekEventConsumerStateForTest();
        return s.ticks >= 1 && !s.tickInFlight;
      },
      5_000,
      "the boot tick",
    );
    assert(captured.nudge !== null, "the consumer subscribed to the nudge channel");
    const nudge = captured.nudge;
    const sub = await db.selectFrom("event_subscriptions").select("id")
      .where("topic", "=", topic).executeTakeFirst();
    assert(sub, "boot synced the registry before the first tick");

    // Publish without nudging (the fake channel is the only wake-up).
    await db.transaction().execute((trx) => publishEvent(trx, { topic, key: "k1", payload: {} }));
    assertEquals((await deliveriesForTopic(topic))[0].status, "pending");
    nudge(JSON.stringify({ topic }));

    await waitFor(
      async () => (await deliveriesForTopic(topic))[0]?.status === "done",
      3_000,
      "done",
    );
    assertEquals(seen, ["k1"]);
    assert(__peekEventConsumerStateForTest().ticks >= 2, "the nudge caused a tick");

    // A malformed message is still a wake-up, never a crash.
    nudge("not json");
    await waitFor(async () => __peekEventConsumerStateForTest().ticks >= 3, 3_000, "third tick");
  } finally {
    await __resetEventConsumerForTest();
    assertEquals(captured.closed, 1, "stop closes the subscription");
    await cleanupTopic(topic);
    _resetEventRegistryForTest();
  }
});

dbTest("event consumer: a nudge during the boot sync coalesces into the first tick", async () => {
  _resetEventRegistryForTest();
  await __resetEventConsumerForTest();
  const topic = uniqueTopic();
  const { captured, subscribe } = fakeChannel();
  try {
    registerEventHandler(topic, () => {}, { name: "noop" });
    startEventConsumer({ subscribe, topics: [topic], runInTestEnv: true, pollIntervalMs: 60_000 });
    // The subscription exists synchronously; the boot sync has not run yet.
    assert(captured.nudge !== null);
    const during = __peekEventConsumerStateForTest();
    assertEquals(during.tickInFlight, true, "the boot counts as a tick in flight");
    captured.nudge(JSON.stringify({ topic }));
    assertEquals(
      __peekEventConsumerStateForTest().timerScheduled,
      true,
      "the boot timer is the only timer; the nudge scheduled nothing of its own",
    );

    await waitFor(
      async () => {
        const s = __peekEventConsumerStateForTest();
        return s.ticks >= 1 && !s.tickInFlight;
      },
      5_000,
      "the boot tick",
    );
    // Give a second loop, if one existed, time to show itself.
    await new Promise((r) => setTimeout(r, 300));
    const s = __peekEventConsumerStateForTest();
    assertEquals(s.ticks, 1, "one loop: the nudge folded into the boot tick");
    assertEquals(s.timerScheduled, true, "and that loop is waiting for the poll interval");
  } finally {
    await __resetEventConsumerForTest();
    await cleanupTopic(topic);
    _resetEventRegistryForTest();
  }
});

dbTest(
  "event consumer: stopEventConsumer waits for the tick in flight to write its outcome",
  async () => {
    _resetEventRegistryForTest();
    await __resetEventConsumerForTest();
    const topic = uniqueTopic();
    const { captured, subscribe } = fakeChannel();
    let started = false;
    try {
      registerEventHandler(topic, async () => {
        started = true;
        await new Promise((r) => setTimeout(r, 300));
      }, { name: "slow" });
      startEventConsumer({
        subscribe,
        topics: [topic],
        runInTestEnv: true,
        pollIntervalMs: 60_000,
      });
      await waitFor(
        async () => {
          const s = __peekEventConsumerStateForTest();
          return s.ticks >= 1 && !s.tickInFlight;
        },
        5_000,
        "the boot tick",
      );
      await publishEventAndNudge({ topic, payload: {} });
      captured.nudge!(JSON.stringify({ topic }));
      await waitFor(() => Promise.resolve(started), 3_000, "the handler to start");

      // The handler is mid-flight. A shutdown must not tear the pool down
      // under it: stop resolves only once the row is written.
      const t0 = Date.now();
      await stopEventConsumer();
      assert(Date.now() - t0 >= 200, "stop waited for the handler");
      assertEquals((await deliveriesForTopic(topic))[0].status, "done");
      assertEquals(__peekEventConsumerStateForTest().tickInFlight, false);
    } finally {
      await __resetEventConsumerForTest();
      await cleanupTopic(topic);
      _resetEventRegistryForTest();
    }
  },
);

dbRedisTest(
  "event consumer: a peer holding the tick lock stops this pod from draining",
  async () => {
    _resetEventRegistryForTest();
    await __resetEventConsumerForTest();
    const topic = uniqueTopic();
    const { captured, subscribe } = fakeChannel();
    const LOCK = "event-consumer";
    let held = false;
    try {
      registerEventHandler(topic, () => {}, { name: "gated" });
      held = await acquireLock(LOCK, 60);
      assert(held, "the test could not take the lock (a stale key from an aborted run?)");

      startEventConsumer({
        subscribe,
        topics: [topic],
        runInTestEnv: true,
        pollIntervalMs: 60_000,
      });
      await waitFor(
        async () => {
          const s = __peekEventConsumerStateForTest();
          return s.ticks >= 1 && !s.tickInFlight;
        },
        5_000,
        "the boot tick",
      );
      await publishEventAndNudge({ topic, payload: {} });
      captured.nudge!(JSON.stringify({ topic }));
      await waitFor(
        async () => {
          const s = __peekEventConsumerStateForTest();
          return s.ticks >= 2 && !s.tickInFlight;
        },
        3_000,
        "the nudged tick",
      );
      await new Promise((r) => setTimeout(r, 100));
      assertEquals(
        (await deliveriesForTopic(topic))[0].status,
        "pending",
        "the peer holds the lock",
      );

      await releaseLock(LOCK);
      held = false;
      captured.nudge!(JSON.stringify({ topic }));
      await waitFor(
        async () => (await deliveriesForTopic(topic))[0]?.status === "done",
        3_000,
        "done once the lock is free",
      );
    } finally {
      await __resetEventConsumerForTest();
      if (held) await releaseLock(LOCK);
      await cleanupTopic(topic);
      _resetEventRegistryForTest();
    }
  },
);

Deno.test("event consumer: NODE_ENV=test stays dormant unless asked", async () => {
  // Forced explicitly: the local .env says development, CI says test.
  const prev = Deno.env.get("NODE_ENV");
  await __resetEventConsumerForTest();
  try {
    Deno.env.set("NODE_ENV", "test");
    startEventConsumer({ subscribe: () => ({ close() {} }) });
    assertEquals(__peekEventConsumerStateForTest().running, false);
  } finally {
    if (prev === undefined) Deno.env.delete("NODE_ENV");
    else Deno.env.set("NODE_ENV", prev);
    await __resetEventConsumerForTest();
  }
});

Deno.test("redisSubscribe: without REDIS_URL the handle is a no-op", () => {
  const saved = Deno.env.get("REDIS_URL");
  try {
    Deno.env.delete("REDIS_URL");
    const h = redisSubscribe("events", () => {});
    h.close();
    h.close(); // idempotent
  } finally {
    if (saved !== undefined) Deno.env.set("REDIS_URL", saved);
  }
});

// ── webhooks ──

const WEBHOOK_SECRET_REF = "EVENTS_TEST_WEBHOOK_SECRET";

function withWebhookSecret(value: string): () => void {
  const prev = Deno.env.get(WEBHOOK_SECRET_REF);
  Deno.env.set(WEBHOOK_SECRET_REF, value);
  return () => {
    if (prev === undefined) Deno.env.delete(WEBHOOK_SECRET_REF);
    else Deno.env.set(WEBHOOK_SECRET_REF, prev);
  };
}

dbTest("webhook delivery: signs the body so the receiver can verify it", async () => {
  const topic = uniqueTopic();
  const org = await createIsolatedUser();
  const restore = withWebhookSecret("whsec_test_0123456789");
  const calls: { url: string; init: RequestInit }[] = [];
  const fakeFetch: typeof fetch = (input, init) => {
    calls.push({ url: String(input), init: init ?? {} });
    return Promise.resolve(new Response("ok", { status: 200 }));
  };
  try {
    const sub = await createWebhookSubscription({
      organizationId: org.org.id,
      topic,
      label: "Order sync",
      url: "https://hooks.example.com/orders",
      secretRef: WEBHOOK_SECRET_REF,
      retries: 3,
    });
    assertEquals(sub.kind, "webhook");
    assertEquals(sub.maxAttempts, 4);
    assertEquals((await listWebhookSubscriptions(org.org.id)).map((s) => s.id), [sub.id]);

    const published = await publishEventAndNudge({
      topic,
      key: "order-9",
      organizationId: org.org.id,
      payload: { total: 42, items: ["a", "b"] },
    });
    const [claimed] = await claimDeliveries(1, { claimedBy: "pod-a", topics: [topic] });
    assertEquals(claimed.kind, "webhook");
    assertEquals(await processDelivery(claimed, { fetch: fakeFetch }), { outcome: "done" });
    assertEquals((await deliveriesForTopic(topic))[0].status, "done");

    assertEquals(calls.length, 1);
    const { url, init } = calls[0];
    assertEquals(url, "https://hooks.example.com/orders");
    assertEquals(init.method, "POST");
    assertEquals(init.redirect, "manual");
    const headers = init.headers as Record<string, string>;
    const body = init.body as string;

    // Verify the way a receiver would: recompute the HMAC independently.
    const ts = headers[EVENT_TIMESTAMP_HEADER];
    assert(/^\d+$/.test(ts), "timestamp header is unix seconds");
    assert(Math.abs(Number(ts) - Date.now() / 1_000) < 30, "timestamp is now");
    const expected = "v1=" +
      createHmac("sha256", "whsec_test_0123456789").update(`${ts}.${body}`).digest("hex");
    assertEquals(headers[EVENT_SIGNATURE_HEADER], expected);
    assertEquals(headers[EVENT_ID_HEADER], published.id);
    assertEquals(headers[EVENT_TOPIC_HEADER], topic);
    assertEquals(headers[EVENT_DELIVERY_HEADER], claimed.id);
    assertEquals(headers[EVENT_ATTEMPT_HEADER], "1");
    assertEquals(headers["content-type"], "application/json");

    const parsed = JSON.parse(body);
    assertEquals(parsed.id, published.id);
    assertEquals(parsed.topic, topic);
    assertEquals(parsed.key, "order-9");
    assertEquals(parsed.payload, { total: 42, items: ["a", "b"] });
    assertEquals(parsed.source, "app");
    assert(typeof parsed.createdAt === "string");
    assertEquals("organizationId" in parsed, false, "the org id is not part of the wire body");

    // A different secret must not verify: the signature is bound to it.
    assertEquals(
      verifyEventSignature({
        secret: "other",
        rawBody: body,
        timestampHeader: ts,
        signatureHeader: headers[EVENT_SIGNATURE_HEADER],
      }),
      { ok: false, reason: "signature-mismatch" },
    );

    // Deactivation is org-scoped: another org cannot touch it.
    const other = await createIsolatedUser();
    try {
      let threw = false;
      try {
        await deactivateWebhookSubscription(other.org.id, sub.id);
      } catch {
        threw = true;
      }
      assert(threw, "another org's deactivate must 404");
      // A delivery fanned out BEFORE the builder turned the webhook off
      // must not be POSTed afterwards: revoked means revoked.
      const backlog = await publishEventAndNudge({
        topic,
        organizationId: org.org.id,
        payload: {},
      });
      assertEquals(backlog.deliveries, 1);
      await deactivateWebhookSubscription(org.org.id, sub.id);
      const after = await publishEventAndNudge({ topic, organizationId: org.org.id, payload: {} });
      assertEquals(after.deliveries, 0, "a deactivated webhook is not fanned out");
      assertEquals(
        (await claimDeliveries(10, { claimedBy: "pod-a", topics: [topic] })).length,
        0,
        "the backlog of a deactivated webhook is parked, not claimed",
      );
      assertEquals(calls.length, 1, "no POST to a revoked URL");
    } finally {
      await other.cleanup();
    }
  } finally {
    restore();
    await cleanupTopic(topic);
    await org.cleanup();
  }
});

dbTest("webhook delivery: a persistent 500 backs off and dead-letters", async () => {
  const topic = uniqueTopic();
  const org = await createIsolatedUser();
  const restore = withWebhookSecret("whsec_test_fail");
  let posts = 0;
  const failingFetch: typeof fetch = () => {
    posts++;
    return Promise.resolve(new Response("upstream exploded", { status: 500 }));
  };
  try {
    await createWebhookSubscription({
      organizationId: org.org.id,
      topic,
      label: "Flaky receiver",
      url: "https://hooks.example.com/flaky",
      secretRef: WEBHOOK_SECRET_REF,
      retries: 1,
    });
    await publishEventAndNudge({ topic, organizationId: org.org.id, payload: {} });

    const [first] = await claimDeliveries(1, { claimedBy: "pod-a", topics: [topic] });
    assertEquals(await processDelivery(first, { fetch: failingFetch, random: noJitter }), {
      outcome: "failed",
      delayMs: 500,
    });
    let [row] = await deliveriesForTopic(topic);
    assertEquals(row.status, "failed");
    assert(row.lastError?.includes("webhook responded 500"), row.lastError ?? "");
    assert(row.lastError?.includes("upstream exploded"), "a short excerpt of the body is kept");

    await db.updateTable("event_deliveries").set({ nextAttemptAt: new Date(Date.now() - 60_000) })
      .where("id", "=", first.id).execute();
    const [second] = await claimDeliveries(1, { claimedBy: "pod-a", topics: [topic] });
    assertEquals(await processDelivery(second, { fetch: failingFetch, random: noJitter }), {
      outcome: "dead",
    });
    [row] = await deliveriesForTopic(topic);
    assertEquals(row.status, "dead");
    assertEquals(row.attempts, 2);
    assertEquals(posts, 2);
  } finally {
    restore();
    await cleanupTopic(topic);
    await org.cleanup();
  }
});

dbTest("webhook delivery: a missing secret env var or a redirect is a failed attempt", async () => {
  const topic = uniqueTopic();
  const org = await createIsolatedUser();
  const restore = withWebhookSecret("present-at-create-time");
  try {
    await createWebhookSubscription({
      organizationId: org.org.id,
      topic,
      label: "Redirecting receiver",
      url: "https://hooks.example.com/moved",
      secretRef: WEBHOOK_SECRET_REF,
      retries: 5,
    });
    await publishEventAndNudge({ topic, organizationId: org.org.id, payload: {} });

    const redirecting: typeof fetch = () =>
      Promise.resolve(
        new Response(null, { status: 302, headers: { location: "https://x.example" } }),
      );
    const [d1] = await claimDeliveries(1, { claimedBy: "pod-a", topics: [topic] });
    const r1 = await processDelivery(d1, { fetch: redirecting, random: noJitter });
    assertEquals(r1.outcome, "failed");
    assert((await deliveriesForTopic(topic))[0].lastError?.includes("302"));

    restore(); // the operator removed the env var
    await db.updateTable("event_deliveries").set({ nextAttemptAt: new Date(Date.now() - 60_000) })
      .where("id", "=", d1.id).execute();
    let called = false;
    const [d2] = await claimDeliveries(1, { claimedBy: "pod-a", topics: [topic] });
    const r2 = await processDelivery(d2, {
      fetch: () => {
        called = true;
        return Promise.resolve(new Response("ok"));
      },
      random: noJitter,
    });
    assertEquals(r2.outcome, "failed");
    assertEquals(called, false, "no POST without a secret to sign with");
    assert((await deliveriesForTopic(topic))[0].lastError?.includes(WEBHOOK_SECRET_REF));
  } finally {
    Deno.env.delete(WEBHOOK_SECRET_REF);
    await cleanupTopic(topic);
    await org.cleanup();
  }
});

dbTest("createWebhookSubscription: refuses a bad URL, topic, label or unset secret", async () => {
  const org = await createIsolatedUser();
  const restore = withWebhookSecret("s");
  const base = {
    organizationId: org.org.id,
    topic: uniqueTopic(),
    label: "x",
    url: "https://hooks.example.com/a",
    secretRef: WEBHOOK_SECRET_REF,
  };
  const rejects = async (input: Parameters<typeof createWebhookSubscription>[0], why: string) => {
    let threw = false;
    try {
      await createWebhookSubscription(input);
    } catch {
      threw = true;
    }
    assert(threw, why);
  };
  try {
    await rejects({ ...base, url: "http://hooks.example.com/a" }, "http");
    await rejects({ ...base, url: "https://10.0.0.1/a" }, "private ip");
    await rejects({ ...base, topic: "OrderCreated" }, "topic shape");
    await rejects({ ...base, label: "   " }, "blank label");
    await rejects({ ...base, secretRef: "lowercase" }, "secretRef shape");
    await rejects({ ...base, secretRef: "EVENTS_TEST_WEBHOOK_SECRET_UNSET" }, "unset secret");
    await rejects({ ...base, retries: 99 }, "retries cap");
    assertEquals((await listWebhookSubscriptions(org.org.id)).length, 0);
  } finally {
    restore();
    await org.cleanup();
  }
});

Deno.test("validateWebhookUrl: https + public hosts only", () => {
  assertEquals(
    validateWebhookUrl("https://hooks.example.com/a?b=1"),
    "https://hooks.example.com/a?b=1",
  );
  assertEquals(validateWebhookUrl("https://8.8.8.8/x"), "https://8.8.8.8/x");
  assertEquals(validateWebhookUrl("https://[2606:4700::1111]/x"), "https://[2606:4700::1111]/x");
  for (
    const bad of [
      "not a url",
      "http://hooks.example.com/a",
      "ftp://hooks.example.com/a",
      "https://user:pw@hooks.example.com/a",
      "https://localhost/a",
      "https://app.localhost/a",
      "https://db.internal/a",
      "https://printer.local/a",
      "https://intranet/a",
      "https://127.0.0.1/a",
      "https://127.1/a",
      "https://0177.0.0.1/a",
      "https://0.0.0.0/a",
      "https://10.1.2.3/a",
      "https://172.16.0.1/a",
      "https://172.31.255.255/a",
      "https://192.168.1.1/a",
      "https://169.254.169.254/latest/meta-data",
      "https://100.64.0.1/a",
      "https://224.0.0.1/a",
      "https://[::1]/a",
      "https://[::]/a",
      "https://[fe80::1]/a",
      "https://[fc00::1]/a",
      "https://[fd12::1]/a",
      "https://[::ffff:127.0.0.1]/a",
      "https://[::ffff:10.0.0.1]/a",
      "https://[64:ff9b::a00:1]/a",
    ]
  ) {
    assertThrows(() => validateWebhookUrl(bad), Error, undefined, bad);
  }
  assertEquals(validateWebhookUrl("https://172.32.0.1/a"), "https://172.32.0.1/a");
});

// ── signing ──

Deno.test("verifyEventSignature: names each failure and accepts a good one", () => {
  const secret = "s3cret";
  const body = '{"id":"x"}';
  const now = 1_800_000_000_000;
  const ts = Math.floor(now / 1_000);
  const sig = signEventBody(secret, ts, body);
  assert(/^v1=[0-9a-f]{64}$/.test(sig));
  const v = (timestampHeader: string | null, signatureHeader: string | null, nowMs = now) =>
    verifyEventSignature({ secret, rawBody: body, timestampHeader, signatureHeader, nowMs });

  assertEquals(v(String(ts), sig), { ok: true });
  assertEquals(v(String(ts - 299), sig), { ok: false, reason: "signature-mismatch" });
  assertEquals(v(null, sig), { ok: false, reason: "missing-timestamp" });
  assertEquals(v("12ab", sig), { ok: false, reason: "malformed-timestamp" });
  assertEquals(v(String(ts - 301), signEventBody(secret, ts - 301, body)), {
    ok: false,
    reason: "stale-timestamp",
  });
  assertEquals(v(String(ts + 301), signEventBody(secret, ts + 301, body)), {
    ok: false,
    reason: "stale-timestamp",
  });
  assertEquals(v(String(ts), null), { ok: false, reason: "missing-signature" });
  assertEquals(v(String(ts), "sha256=abc"), { ok: false, reason: "malformed-signature" });
  assertEquals(v(String(ts), "v1=" + "0".repeat(64)), { ok: false, reason: "signature-mismatch" });
  assertEquals(
    verifyEventSignature({
      secret,
      rawBody: body + " ",
      timestampHeader: String(ts),
      signatureHeader: sig,
      nowMs: now,
    }),
    { ok: false, reason: "signature-mismatch" },
  );
});

// ── retention ──

dbTest(
  "sweepEventRetention: deletes old done deliveries and old events, keeps recent rows",
  async () => {
    _resetEventRegistryForTest();
    const topic = uniqueTopic();
    try {
      registerEventHandler(topic, () => {}, { name: "keep", idempotencyKey: (e) => e.id });
      await syncSubscriptionsFromRegistry();

      const oldEvent = await publishEventAndNudge({ topic, key: "old", payload: {} });
      const oldDone = await publishEventAndNudge({ topic, key: "old-done", payload: {} });
      const fresh = await publishEventAndNudge({ topic, key: "fresh", payload: {} });

      // Run every delivery through the handler so each has a receipt.
      const claimed = await claimDeliveries(10, { claimedBy: "pod-a", topics: [topic] });
      for (const d of claimed) assertEquals((await processDelivery(d)).outcome, "done");
      assertEquals(claimed.length, 3);

      // Backdate: one event past the event window, one delivery past the
      // delivery window (its event still inside), one fresh.
      await sql`UPDATE events SET created_at = now() - interval '100 days' WHERE id = ${oldEvent.id}`
        .execute(db);
      await sql`UPDATE event_deliveries SET done_at = now() - interval '10 days' WHERE event_id = ${oldDone.id}`
        .execute(db);

      const r = await sweepEventRetention({
        doneDeliveriesAfterDays: 7,
        eventsAfterDays: 90,
        batch: 1,
      });
      assertEquals(r, { deliveriesDeleted: 1, eventsDeleted: 1 });

      const events = await db.selectFrom("events").select("id").where("topic", "=", topic)
        .execute();
      assertEquals(events.map((e) => e.id).sort(), [oldDone.id, fresh.id].sort());
      const deliveries = await db.selectFrom("event_deliveries").select("eventId")
        .where("eventId", "in", [oldEvent.id, oldDone.id, fresh.id]).execute();
      assertEquals(deliveries.map((d) => d.eventId), [fresh.id]);
      const receipts = await db.selectFrom("event_handler_receipts").select("eventId")
        .where("eventId", "in", [oldEvent.id, oldDone.id, fresh.id]).execute();
      assertEquals(
        receipts.map((x) => x.eventId).sort(),
        [oldDone.id, fresh.id].sort(),
        "a receipt lives as long as its event, not its delivery",
      );

      // 0 days disables that half of the sweep.
      await sql`UPDATE events SET created_at = now() - interval '100 days' WHERE id = ${fresh.id}`
        .execute(db);
      assertEquals(await sweepEventRetention({ doneDeliveriesAfterDays: 0, eventsAfterDays: 0 }), {
        deliveriesDeleted: 0,
        eventsDeleted: 0,
      });
    } finally {
      await cleanupTopic(topic);
      _resetEventRegistryForTest();
    }
  },
);

dbTest(
  "sweepEventRetention: an old event with an unfinished delivery on an active subscription is held",
  async () => {
    _resetEventRegistryForTest();
    const topic = uniqueTopic();
    const parkedTopic = uniqueTopic();
    try {
      registerEventHandler(topic, () => {}, { name: "slowReceiver", retries: 30 });
      registerEventHandler(parkedTopic, () => {}, { name: "retired" });
      await syncSubscriptionsFromRegistry();

      const inBackoff = await publishEventAndNudge({ topic, key: "in-backoff", payload: {} });
      const replayed = await publishEventAndNudge({ topic, key: "replayed", payload: {} });
      const parked = await publishEventAndNudge({ topic: parkedTopic, key: "parked", payload: {} });

      // One delivery mid-retry, one done then replayed, one pending on a
      // subscription that was deactivated (parked: never going to run).
      const [d1] = await claimDeliveries(1, { claimedBy: "pod-a", topics: [topic] });
      assertEquals(d1.event.id, inBackoff.id);
      await sql`UPDATE event_deliveries SET status = 'failed', next_attempt_at = now() + interval '1 hour' WHERE id = ${d1.id}`
        .execute(db);
      const [d2] = await claimDeliveries(1, { claimedBy: "pod-a", topics: [topic] });
      assertEquals(d2.event.id, replayed.id);
      assertEquals((await processDelivery(d2)).outcome, "done");
      await sql`UPDATE event_deliveries SET status = 'pending' WHERE id = ${d2.id}`.execute(db);
      await db.updateTable("event_subscriptions").set({ active: false })
        .where("topic", "=", parkedTopic).execute();

      await sql`UPDATE events SET created_at = now() - interval '100 days' WHERE topic IN (${topic}, ${parkedTopic})`
        .execute(db);
      const r = await sweepEventRetention({ doneDeliveriesAfterDays: 7, eventsAfterDays: 90 });
      assertEquals(r.eventsDeleted, 1, "only the parked event goes");

      const left = await db.selectFrom("events").select("id")
        .where("id", "in", [inBackoff.id, replayed.id, parked.id]).execute();
      assertEquals(left.map((e) => e.id).sort(), [inBackoff.id, replayed.id].sort());

      // Once the work finishes, the next sweep takes them.
      await sql`UPDATE event_deliveries SET status = 'dead' WHERE id IN (${d1.id}, ${d2.id})`
        .execute(db);
      assertEquals(
        (await sweepEventRetention({ doneDeliveriesAfterDays: 7, eventsAfterDays: 90 }))
          .eventsDeleted,
        2,
      );
    } finally {
      await cleanupTopic(topic);
      await cleanupTopic(parkedTopic);
      _resetEventRegistryForTest();
    }
  },
);
