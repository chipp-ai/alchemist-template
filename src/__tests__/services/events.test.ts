/**
 * The durable event log: publish, fan out, claim, retry, dead-letter,
 * idempotency. Runs against the real Postgres (no in-process mode);
 * skipped when no DATABASE_URL is set.
 *
 * What the cases pin:
 *
 *   - publishing inside a transaction that rolls back leaves NO event
 *     (exactly-once emission is the transaction, nothing else)
 *   - publish then commit creates one delivery per active subscription
 *     for the topic, and none for inactive or other-topic ones
 *   - an org-scoped subscription only hears its own org's events
 *   - two concurrent claimers never claim the same delivery
 *   - a failing handler backs off exponentially (deterministic jitter)
 *     and dead-letters after its attempt budget
 *   - an idempotency key stops a redelivered delivery from running the
 *     handler twice, and stops a second event with the same key too
 *   - a claimer that dies mid-handler is requeued by the stale reaper
 *     and the lost attempt still counts
 *   - boot sync is idempotent and deactivates removed handlers without
 *     deleting their rows
 *
 * Every test uses its own topic (`test.<id>.happened`) and deletes its
 * events and subscriptions by that topic, so files sharing a worker
 * schema never see each other's rows.
 */

import { assert, assertEquals, assertNotEquals, assertRejects } from "@std/assert";
import { createIsolatedUser, getTestDb } from "../helpers.ts";
import {
  _resetEventRegistryForTest,
  claimDeliveries,
  type ClaimedDelivery,
  completeDelivery,
  computeBackoffMs,
  failDelivery,
  getRunnableHandlers,
  processDelivery,
  publishEvent,
  publishEventAndNudge,
  registerEventHandler,
  releaseClaims,
  replayDelivery,
  requeueStaleDeliveries,
  syncSubscriptionsFromRegistry,
} from "@/lib/events.ts";
import { uuidv7, uuidv7Time } from "@/lib/uuidv7.ts";
import { sql } from "kysely";

const HAS_DB = !!(Deno.env.get("TEST_DATABASE_URL") || Deno.env.get("DATABASE_URL"));

function dbTest(name: string, fn: () => Promise<void>) {
  Deno.test({ name, ignore: !HAS_DB, sanitizeResources: false, sanitizeOps: false, fn });
}

const db = HAS_DB ? getTestDb() : null!;

let topicCounter = 0;
function uniqueTopic(): string {
  topicCounter++;
  return `test.t${Date.now().toString(36)}${
    Math.random().toString(36).slice(2, 7)
  }${topicCounter}.happened`;
}

/** Delete everything a test created under its topic (deliveries and receipts cascade). */
async function cleanupTopic(topic: string): Promise<void> {
  await db.deleteFrom("events").where("topic", "=", topic).execute();
  await db.deleteFrom("event_subscriptions").where("topic", "=", topic).execute();
}

async function deliveriesForTopic(topic: string) {
  return await db
    .selectFrom("event_deliveries as d")
    .innerJoin("events as e", "e.id", "d.eventId")
    .select([
      "d.id",
      "d.status",
      "d.attempts",
      "d.nextAttemptAt",
      "d.lastError",
      "d.subscriptionId",
      "d.claimedBy",
    ])
    .where("e.topic", "=", topic)
    .orderBy("d.id")
    .execute();
}

const noJitter = () => 0;

// ── uuidv7 ──

Deno.test("uuidv7: version 7, variant 10, and the time prefix is the minting time", () => {
  const at = 1_726_000_000_123;
  const id = uuidv7(at);
  assert(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id), id);
  assertEquals(uuidv7Time(id), at);
  assert(uuidv7(at) < uuidv7(at + 1), "a later millisecond sorts after an earlier one");
});

// ── registry ──

Deno.test("registerEventHandler: rejects a bad topic, an anonymous handler and a duplicate", () => {
  _resetEventRegistryForTest();
  try {
    assertRejectsSync(() => registerEventHandler("OrderCreated", () => {}, { name: "x" }));
    assertRejectsSync(() => registerEventHandler("order.created", () => {}));
    registerEventHandler("order.created", () => {}, { name: "sendMail", retries: 2 });
    assertRejectsSync(() => registerEventHandler("order.created", () => {}, { name: "sendMail" }));
  } finally {
    _resetEventRegistryForTest();
  }
});

function assertRejectsSync(fn: () => unknown): void {
  let threw = false;
  try {
    fn();
  } catch {
    threw = true;
  }
  assert(threw, "expected a throw");
}

Deno.test("computeBackoffMs: exponential from 1s, capped at 1h, equal jitter", () => {
  assertEquals(computeBackoffMs(1, noJitter), 500);
  assertEquals(computeBackoffMs(2, noJitter), 1_000);
  assertEquals(computeBackoffMs(3, noJitter), 2_000);
  assertEquals(computeBackoffMs(1, () => 0.999_999), 1_000);
  assertEquals(computeBackoffMs(40, noJitter), 30 * 60 * 1_000);
  assertEquals(computeBackoffMs(40, () => 1), 60 * 60 * 1_000);
});

// ── publish ──

dbTest("publishEvent: a rolled-back transaction leaves no event and no delivery", async () => {
  _resetEventRegistryForTest();
  const topic = uniqueTopic();
  try {
    registerEventHandler(topic, () => {}, { name: "noop" });
    await syncSubscriptionsFromRegistry();

    await assertRejects(() =>
      db.transaction().execute(async (trx) => {
        const r = await publishEvent(trx, { topic, key: "k1", payload: { n: 1 } });
        assertEquals(r.deliveries, 1, "fanout happens inside the transaction");
        throw new Error("business change failed after publish");
      })
    );

    const events = await db.selectFrom("events").select("id").where("topic", "=", topic)
      .execute();
    assertEquals(events.length, 0, "the event must roll back with the change");
    assertEquals((await deliveriesForTopic(topic)).length, 0);
  } finally {
    await cleanupTopic(topic);
    _resetEventRegistryForTest();
  }
});

dbTest(
  "publishEventAndNudge: one delivery per active subscription for the topic, none for others",
  async () => {
    _resetEventRegistryForTest();
    const topic = uniqueTopic();
    const otherTopic = uniqueTopic();
    try {
      registerEventHandler(topic, () => {}, { name: "first" });
      registerEventHandler(topic, () => {}, { name: "second" });
      registerEventHandler(otherTopic, () => {}, { name: "elsewhere" });
      await syncSubscriptionsFromRegistry();
      // An inactive subscription on the same topic must not fan out.
      await db.insertInto("event_subscriptions")
        .values({ organizationId: null, topic, handler: "retired", kind: "handler", active: false })
        .execute();

      const r = await publishEventAndNudge({ topic, key: "order-1", payload: { total: 42 } });
      assertEquals(r.inserted, true);
      assertEquals(r.deliveries, 2);
      assertEquals(uuidv7Time(r.id) > Date.now() - 60_000, true, "id is a fresh UUIDv7");

      const rows = await deliveriesForTopic(topic);
      assertEquals(rows.length, 2);
      assert(rows.every((d) => d.status === "pending" && d.attempts === 0));

      const stored = await db.selectFrom("events").selectAll().where("id", "=", r.id)
        .executeTakeFirstOrThrow();
      assertEquals(stored.payload, { total: 42 }, "payload is a jsonb object, not a string");
      assertEquals(stored.source, "app");

      // Supplying the same id again is a no-op with no new deliveries.
      const again = await publishEventAndNudge({ id: r.id, topic, payload: {} });
      assertEquals(again.inserted, false);
      assertEquals(again.deliveries, 0);
      assertEquals((await deliveriesForTopic(topic)).length, 2);
    } finally {
      await cleanupTopic(topic);
      await cleanupTopic(otherTopic);
      _resetEventRegistryForTest();
    }
  },
);

dbTest(
  "publishEvent: an org-scoped subscription hears only its own org; a global one hears both",
  async () => {
    _resetEventRegistryForTest();
    const topic = uniqueTopic();
    const a = await createIsolatedUser();
    const b = await createIsolatedUser();
    try {
      registerEventHandler(topic, () => {}, { name: "global" });
      await syncSubscriptionsFromRegistry();
      const hook = await db.insertInto("event_subscriptions")
        .values({
          organizationId: a.org.id,
          topic,
          handler: "org-a-webhook",
          kind: "webhook",
          url: "https://example.invalid/hook",
          secretRef: "ORG_A_HOOK_SECRET",
        })
        .returning("id")
        .executeTakeFirstOrThrow();

      const forA = await publishEventAndNudge({ topic, organizationId: a.org.id, payload: {} });
      const forB = await publishEventAndNudge({ topic, organizationId: b.org.id, payload: {} });
      const forNobody = await publishEventAndNudge({ topic, source: "platform", payload: {} });
      assertEquals(forA.deliveries, 2, "org A: the global handler and its own webhook");
      assertEquals(forB.deliveries, 1, "org B: the global handler only");
      assertEquals(forNobody.deliveries, 1, "no org: the global handler only");

      const hookDeliveries = await db.selectFrom("event_deliveries").select("eventId")
        .where("subscriptionId", "=", hook.id).execute();
      assertEquals(hookDeliveries.map((d) => d.eventId), [forA.id]);
    } finally {
      await cleanupTopic(topic);
      await a.cleanup();
      await b.cleanup();
      _resetEventRegistryForTest();
    }
  },
);

dbTest(
  "publishEvent: rejects an array payload (postgres.js would store it as a Postgres array)",
  async () => {
    const topic = uniqueTopic();
    await assertRejects(
      () =>
        db.transaction().execute((trx) =>
          publishEvent(trx, { topic, payload: [1, 2] as unknown as Record<string, unknown> })
        ),
      Error,
      "plain object",
    );
    assertEquals(
      (await db.selectFrom("events").select("id").where("topic", "=", topic).execute()).length,
      0,
    );
  },
);

// ── claim ──

dbTest("claimDeliveries: two concurrent claimers never claim the same delivery", async () => {
  _resetEventRegistryForTest();
  const topic = uniqueTopic();
  try {
    registerEventHandler(topic, () => {}, { name: "worker" });
    await syncSubscriptionsFromRegistry();
    const total = 24;
    for (let i = 0; i < total; i++) {
      await publishEventAndNudge({ topic, key: `k${i}`, payload: { i } });
    }

    const [a, b] = await Promise.all([
      claimDeliveries(total / 2, { claimedBy: "pod-a", topics: [topic] }),
      claimDeliveries(total / 2, { claimedBy: "pod-b", topics: [topic] }),
    ]);
    const idsA = new Set(a.map((d) => d.id));
    const idsB = new Set(b.map((d) => d.id));
    assertEquals(a.length + b.length, total, "every delivery was claimed exactly once");
    for (const id of idsA) assert(!idsB.has(id), `delivery ${id} was claimed by both`);

    const rows = await deliveriesForTopic(topic);
    assert(rows.every((d) => d.status === "running" && d.attempts === 1));
    assertEquals((await claimDeliveries(10, { claimedBy: "pod-c", topics: [topic] })).length, 0);

    // A claimed row carries the event and the subscription it needs.
    const first = a[0] ?? b[0];
    assertEquals(first.handler, "worker");
    assertEquals(first.kind, "handler");
    assertEquals(first.maxAttempts, 8);
    assertEquals(first.event.topic, topic);
    assertEquals(typeof first.event.payload.i, "number");
    assert(first.event.createdAt instanceof Date);
  } finally {
    await cleanupTopic(topic);
    _resetEventRegistryForTest();
  }
});

dbTest("claimDeliveries: a failed delivery is not due until next_attempt_at", async () => {
  _resetEventRegistryForTest();
  const topic = uniqueTopic();
  try {
    registerEventHandler(topic, () => {}, { name: "later" });
    await syncSubscriptionsFromRegistry();
    await publishEventAndNudge({ topic, payload: {} });
    const [claimed] = await claimDeliveries(1, { claimedBy: "pod-a", topics: [topic] });
    const outcome = await failDelivery(claimed, new Error("boom"), { random: noJitter });
    assertEquals(outcome.status, "failed");
    assertEquals(outcome.delayMs, 500);
    assertEquals((await claimDeliveries(1, { claimedBy: "pod-a", topics: [topic] })).length, 0);

    // Back-date the retry and it is claimable again, on attempt 2.
    await db.updateTable("event_deliveries").set({ nextAttemptAt: new Date(Date.now() - 1000) })
      .where("id", "=", claimed.id).execute();
    const [second] = await claimDeliveries(1, { claimedBy: "pod-b", topics: [topic] });
    assertEquals(second.id, claimed.id);
    assertEquals(second.attempts, 2);
    assertEquals(await completeDelivery(second), true);
    assertEquals(await completeDelivery(second), false, "already done: no longer running");
    assertEquals((await deliveriesForTopic(topic))[0].status, "done");
  } finally {
    await cleanupTopic(topic);
    _resetEventRegistryForTest();
  }
});

// ── process: retry and dead-letter ──

dbTest(
  "processDelivery: a failing handler backs off exponentially and dead-letters after its attempts",
  async () => {
    _resetEventRegistryForTest();
    const topic = uniqueTopic();
    let calls = 0;
    try {
      registerEventHandler(topic, () => {
        calls++;
        throw new Error(`attempt ${calls} failed`);
      }, { name: "flaky", retries: 2 });
      await syncSubscriptionsFromRegistry();
      await publishEventAndNudge({ topic, payload: {} });

      // Between attempts the row is backdated to "due" by id, so no test
      // sleeps through a backoff; the delay itself is asserted.
      const makeDue = (id: string) =>
        db.updateTable("event_deliveries").set({ nextAttemptAt: new Date(Date.now() - 60_000) })
          .where("id", "=", id).execute();
      const claim = async (): Promise<ClaimedDelivery> => {
        const rows = await claimDeliveries(1, { claimedBy: "pod-a", topics: [topic] });
        assertEquals(rows.length, 1, "the delivery is due");
        return rows[0];
      };

      const one = await claim();
      assertEquals(await processDelivery(one, { random: noJitter }), {
        outcome: "failed",
        delayMs: 500,
      });
      assertEquals(
        (await claimDeliveries(1, { claimedBy: "pod-a", topics: [topic] })).length,
        0,
        "not due yet",
      );
      await makeDue(one.id);
      const two = await claim();
      assertEquals(await processDelivery(two, { random: noJitter }), {
        outcome: "failed",
        delayMs: 1_000,
      });
      await makeDue(two.id);
      const three = await claim();
      assertEquals(await processDelivery(three, { random: noJitter }), { outcome: "dead" });
      assertEquals(calls, 3, "retries: 2 means three attempts in total");

      const [row] = await deliveriesForTopic(topic);
      assertEquals(row.status, "dead");
      assertEquals(row.attempts, 3);
      assert(row.lastError?.includes("attempt 3 failed"), row.lastError ?? "");
      assertEquals((await claimDeliveries(1, { claimedBy: "pod-a", topics: [topic] })).length, 0);

      // Replay is "set it back to pending"; the budget starts over.
      assertEquals(await replayDelivery(row.id), true);
      const replayed = await claim();
      assertEquals(replayed.attempts, 1);
    } finally {
      await cleanupTopic(topic);
      _resetEventRegistryForTest();
    }
  },
);

dbTest(
  "processDelivery: an unregistered handler is released unrun, no attempt burned",
  async () => {
    _resetEventRegistryForTest();
    const topic = uniqueTopic();
    try {
      registerEventHandler(topic, () => {}, { name: "gone", retries: 0 });
      await syncSubscriptionsFromRegistry();
      await publishEventAndNudge({ topic, payload: {} });
      const [claimed] = await claimDeliveries(1, { claimedBy: "pod-a", topics: [topic] });
      _resetEventRegistryForTest(); // the pod that claimed it no longer has the code
      const outcome = await processDelivery(claimed, { random: noJitter });
      assertEquals(outcome, { outcome: "released", reason: "handler-not-registered" });
      const [row] = await deliveriesForTopic(topic);
      assertEquals(row.status, "pending", "given back, not failed");
      assertEquals(row.attempts, 0, "the claim's attempt is uncounted");
      assertEquals(row.claimedBy, null);
      assert(row.nextAttemptAt.getTime() > Date.now() - 1_000, "due shortly, not immediately");
    } finally {
      await cleanupTopic(topic);
      _resetEventRegistryForTest();
    }
  },
);

dbTest(
  "claimDeliveries: with runnableHandlers, a pod never claims a handler it lacks",
  async () => {
    _resetEventRegistryForTest();
    const topic = uniqueTopic();
    const a = await createIsolatedUser();
    try {
      registerEventHandler(topic, () => {}, { name: "oldHandler" });
      registerEventHandler(topic, () => {}, { name: "newHandler" });
      await syncSubscriptionsFromRegistry();
      await db.insertInto("event_subscriptions")
        .values({
          organizationId: a.org.id,
          topic,
          handler: "hook",
          kind: "webhook",
          url: "https://hooks.example.com/x",
          secretRef: "X_SECRET",
        })
        .execute();
      await publishEventAndNudge({ topic, organizationId: a.org.id, payload: {} });
      assertEquals((await deliveriesForTopic(topic)).length, 3);

      // An old-version pod: it has only oldHandler. It takes that one and
      // the webhook (no code needed) and leaves newHandler for a new pod.
      const oldPod = await claimDeliveries(10, {
        claimedBy: "pod-old",
        topics: [topic],
        runnableHandlers: [{ topic, handler: "oldHandler" }],
      });
      assertEquals(oldPod.map((d) => d.handler).sort(), ["hook", "oldHandler"]);

      // A pod with the full registry gets the rest.
      const newPod = await claimDeliveries(10, {
        claimedBy: "pod-new",
        topics: [topic],
        runnableHandlers: getRunnableHandlers(),
      });
      assertEquals(newPod.map((d) => d.handler), ["newHandler"]);

      // An empty registry claims webhooks only.
      await publishEventAndNudge({ topic, organizationId: a.org.id, payload: {} });
      const webhooksOnly = await claimDeliveries(10, {
        claimedBy: "pod-empty",
        topics: [topic],
        runnableHandlers: [],
      });
      assertEquals(webhooksOnly.map((d) => d.kind), ["webhook"]);
    } finally {
      await cleanupTopic(topic);
      await a.cleanup();
      _resetEventRegistryForTest();
    }
  },
);

dbTest(
  "claimDeliveries: an inactive subscription's deliveries are parked, never claimed",
  async () => {
    _resetEventRegistryForTest();
    const topic = uniqueTopic();
    try {
      registerEventHandler(topic, () => {}, { name: "parked" });
      await syncSubscriptionsFromRegistry();
      await publishEventAndNudge({ topic, payload: {} });
      // A failed delivery in backoff, due now, on a subscription that is
      // then deactivated (a builder turned the webhook off, or the handler
      // was removed): it must not run.
      const [first] = await claimDeliveries(1, { claimedBy: "pod-a", topics: [topic] });
      await failDelivery(first, new Error("receiver down"), { random: noJitter });
      await db.updateTable("event_deliveries").set({ nextAttemptAt: new Date(Date.now() - 60_000) })
        .where("id", "=", first.id).execute();
      await db.updateTable("event_subscriptions").set({ active: false })
        .where("topic", "=", topic).execute();

      assertEquals((await claimDeliveries(10, { claimedBy: "pod-a", topics: [topic] })).length, 0);
      let [row] = await deliveriesForTopic(topic);
      assertEquals(row.status, "failed", "parked, still visible");

      // Reactivate and it is claimable again, budget intact.
      await db.updateTable("event_subscriptions").set({ active: true })
        .where("topic", "=", topic).execute();
      const [again] = await claimDeliveries(10, { claimedBy: "pod-a", topics: [topic] });
      assertEquals(again.id, first.id);
      assertEquals(again.attempts, 2);
      [row] = await deliveriesForTopic(topic);
      assertEquals(row.status, "running");
    } finally {
      await cleanupTopic(topic);
      _resetEventRegistryForTest();
    }
  },
);

dbTest(
  "claimDeliveries: a claim that times out during pool acquisition claims nothing",
  async () => {
    _resetEventRegistryForTest();
    const topic = uniqueTopic();
    try {
      registerEventHandler(topic, () => {}, { name: "orphan" });
      await syncSubscriptionsFromRegistry();
      await publishEventAndNudge({ topic, payload: {} });

      // Saturate the (local, max 5) pool so the claim waits for a slot
      // longer than its timeout; the transaction then starts AFTER the
      // caller rejected and must roll back instead of claiming.
      const holders = Array.from(
        { length: 6 },
        () => sql`SELECT pg_sleep(0.7)`.execute(db),
      );
      await new Promise((r) => setTimeout(r, 50));
      let rejected: Error | null = null;
      try {
        await claimDeliveries(10, { claimedBy: "ghost-pod", topics: [topic], timeoutMs: 150 });
      } catch (err) {
        rejected = err as Error;
      }
      assert(rejected?.message.includes("claim timed out"), rejected?.message ?? "no rejection");
      await Promise.all(holders);
      await new Promise((r) => setTimeout(r, 200));

      const [row] = await deliveriesForTopic(topic);
      assertEquals(row.status, "pending", "the late transaction must not claim");
      assertEquals(row.attempts, 0);
      assertEquals(row.claimedBy, null);
      // And the row is still claimable right away.
      assertEquals((await claimDeliveries(1, { claimedBy: "pod-a", topics: [topic] })).length, 1);
    } finally {
      await cleanupTopic(topic);
      _resetEventRegistryForTest();
    }
  },
);

dbTest("releaseClaims: gives rows back unrun and is fenced on the claim token", async () => {
  _resetEventRegistryForTest();
  const topic = uniqueTopic();
  try {
    registerEventHandler(topic, () => {}, { name: "give-back" });
    await syncSubscriptionsFromRegistry();
    await publishEventAndNudge({ topic, payload: {} });
    await publishEventAndNudge({ topic, payload: {} });
    const claimed = await claimDeliveries(10, { claimedBy: "pod-a", topics: [topic] });
    assertEquals(claimed.length, 2);

    // A stale token (wrong attempts) matches nothing.
    assertEquals(await releaseClaims([{ ...claimed[0], attempts: 99 }]), 0);
    assertEquals(await releaseClaims(claimed, { delayMs: 0 }), 2);
    const rows = await deliveriesForTopic(topic);
    assert(rows.every((r) => r.status === "pending" && r.attempts === 0 && r.claimedBy === null));
    assertEquals((await claimDeliveries(10, { claimedBy: "pod-b", topics: [topic] })).length, 2);
  } finally {
    await cleanupTopic(topic);
    _resetEventRegistryForTest();
  }
});

dbTest(
  "completeDelivery / failDelivery: a superseded claim cannot write over a peer's run",
  async () => {
    _resetEventRegistryForTest();
    const topic = uniqueTopic();
    try {
      registerEventHandler(topic, () => {}, { name: "slowNotDead", retries: 1 });
      await syncSubscriptionsFromRegistry();
      await publishEventAndNudge({ topic, payload: {} });

      // Pod A claims, then stalls past the stale window.
      const [a] = await claimDeliveries(1, { claimedBy: "pod-a", topics: [topic] });
      await db.updateTable("event_deliveries").set({ claimedAt: new Date(Date.now() - 120_000) })
        .where("id", "=", a.id).execute();
      assertEquals(await requeueStaleDeliveries(60_000), 1);
      const [b] = await claimDeliveries(1, { claimedBy: "pod-b", topics: [topic] });
      assertEquals(b.attempts, 2);

      // Pod A wakes up and reports: both writes must match zero rows.
      assertEquals(await failDelivery(a, new Error("late timeout from A"), { random: noJitter }), {
        status: "failed",
        delayMs: 500,
      });
      let [row] = await deliveriesForTopic(topic);
      assertEquals([row.status, row.claimedBy, row.attempts, row.lastError], [
        "running",
        "pod-b",
        2,
        "stale claim: consumer did not finish",
      ]);
      assertEquals(await completeDelivery(a), false);
      [row] = await deliveriesForTopic(topic);
      assertEquals(row.status, "running");

      // Pod B's own report lands.
      assertEquals(await completeDelivery(b), true);
      [row] = await deliveriesForTopic(topic);
      assertEquals(row.status, "done");
      assertEquals((await claimDeliveries(1, { claimedBy: "pod-c", topics: [topic] })).length, 0);
    } finally {
      await cleanupTopic(topic);
      _resetEventRegistryForTest();
    }
  },
);

// ── timeouts ──

dbTest(
  "processDelivery: a hung handler times out, aborts ctx.signal, retries no sooner than one timeout later",
  async () => {
    _resetEventRegistryForTest();
    const topic = uniqueTopic();
    let signalAborted = false;
    let calls = 0;
    try {
      registerEventHandler(topic, (_e, ctx) => {
        calls++;
        return new Promise<void>((resolve) => {
          ctx.signal.addEventListener("abort", () => {
            signalAborted = true;
            resolve(); // a well-behaved handler stops when told
          });
        });
      }, { name: "hung" });
      await syncSubscriptionsFromRegistry();
      await publishEventAndNudge({ topic, payload: {} });
      const [claimed] = await claimDeliveries(1, { claimedBy: "pod-a", topics: [topic] });

      // Backoff for attempt 1 with no jitter is 500 ms; the floor wins.
      const outcome = await processDelivery(claimed, { handlerTimeoutMs: 600, random: noJitter });
      assertEquals(outcome, { outcome: "failed", delayMs: 600 });
      assertEquals(signalAborted, true);
      const [row] = await deliveriesForTopic(topic);
      assertEquals(row.status, "failed");
      assert(row.lastError?.includes("timed out after 600ms"), row.lastError ?? "");
      assert(
        row.nextAttemptAt.getTime() >= Date.now() + 400,
        "the retry cannot overlap the ghost of attempt 1",
      );
      assertEquals(calls, 1);
    } finally {
      await cleanupTopic(topic);
      _resetEventRegistryForTest();
    }
  },
);

dbTest("processDelivery: a webhook whose fetch never resolves is a timed-out attempt", async () => {
  const topic = uniqueTopic();
  const a = await createIsolatedUser();
  const prev = Deno.env.get("HUNG_HOOK_SECRET");
  Deno.env.set("HUNG_HOOK_SECRET", "s");
  try {
    await db.insertInto("event_subscriptions")
      .values({
        organizationId: a.org.id,
        topic,
        handler: "hung-hook",
        kind: "webhook",
        url: "https://hooks.example.com/hung",
        secretRef: "HUNG_HOOK_SECRET",
      })
      .execute();
    await publishEventAndNudge({ topic, organizationId: a.org.id, payload: {} });
    const [claimed] = await claimDeliveries(1, { claimedBy: "pod-a", topics: [topic] });
    const never: typeof fetch = () => new Promise(() => {});
    const outcome = await processDelivery(claimed, {
      fetch: never,
      handlerTimeoutMs: 600,
      random: noJitter,
    });
    assertEquals(outcome, { outcome: "failed", delayMs: 600 });
    const [row] = await deliveriesForTopic(topic);
    assert(row.lastError?.includes("timed out"), row.lastError ?? "");
  } finally {
    if (prev === undefined) Deno.env.delete("HUNG_HOOK_SECRET");
    else Deno.env.set("HUNG_HOOK_SECRET", prev);
    await cleanupTopic(topic);
    await a.cleanup();
  }
});

// ── idempotency ──

dbTest(
  "processDelivery: an idempotency key prevents double-processing on redelivery and on a duplicate event",
  async () => {
    _resetEventRegistryForTest();
    const topic = uniqueTopic();
    let runs = 0;
    try {
      registerEventHandler(topic, () => {
        runs++;
      }, { name: "chargeCard", idempotencyKey: (e) => e.key ?? e.id });
      await syncSubscriptionsFromRegistry();
      const published = await publishEventAndNudge({ topic, key: "order-7", payload: {} });

      const [first] = await claimDeliveries(1, { claimedBy: "pod-a", topics: [topic] });
      assertEquals(await processDelivery(first), { outcome: "done" });
      assertEquals(runs, 1);

      // The same delivery, redelivered (replayed): skipped, still done.
      assertEquals(await replayDelivery(first.id), true);
      const [again] = await claimDeliveries(1, { claimedBy: "pod-b", topics: [topic] });
      assertEquals(again.id, first.id);
      assertEquals(await processDelivery(again), {
        outcome: "skipped",
        reason: "idempotency-key-seen",
      });
      assertEquals(runs, 1, "the handler must not run twice for one key");
      assertEquals((await deliveriesForTopic(topic))[0].status, "done");

      // A second event for the same business key (a duplicate from an
      // external source) is also skipped.
      const dup = await publishEventAndNudge({
        topic,
        key: "order-7",
        source: "external",
        payload: {},
      });
      assertNotEquals(dup.id, published.id);
      const [dupDelivery] = await claimDeliveries(1, { claimedBy: "pod-a", topics: [topic] });
      assertEquals(await processDelivery(dupDelivery), {
        outcome: "skipped",
        reason: "idempotency-key-seen",
      });
      assertEquals(runs, 1);

      const receipts = await db.selectFrom("event_handler_receipts").selectAll()
        .where("eventId", "=", published.id).execute();
      assertEquals(receipts.length, 1);
      assertEquals(receipts[0].idempotencyKey, "global:order-7", "the stored key is org-scoped");
    } finally {
      await cleanupTopic(topic);
      _resetEventRegistryForTest();
    }
  },
);

dbTest(
  "processDelivery: two same-key deliveries in one batch run the handler once (the key is reserved before it runs)",
  async () => {
    _resetEventRegistryForTest();
    const topic = uniqueTopic();
    let runs = 0;
    try {
      registerEventHandler(topic, async () => {
        runs++;
        await new Promise((r) => setTimeout(r, 80));
      }, { name: "sendOnce", idempotencyKey: (e) => e.key ?? e.id });
      await syncSubscriptionsFromRegistry();
      await publishEventAndNudge({ topic, key: "order-42", payload: {} });
      await publishEventAndNudge({ topic, key: "order-42", source: "external", payload: {} });

      const both = await claimDeliveries(10, { claimedBy: "pod-a", topics: [topic] });
      assertEquals(both.length, 2);
      const outcomes = await Promise.all(both.map((d) => processDelivery(d)));
      assertEquals(runs, 1, "the handler must run once for one key");
      const kinds = outcomes.map((o) => o.outcome).sort();
      assertEquals(kinds, ["done", "released"], "the loser is parked behind the in-flight run");

      // The loser comes back once the owner is done and is skipped.
      const loser = both[outcomes.findIndex((o) => o.outcome === "released")];
      await db.updateTable("event_deliveries").set({ nextAttemptAt: new Date(Date.now() - 1_000) })
        .where("id", "=", loser.id).execute();
      const [again] = await claimDeliveries(1, { claimedBy: "pod-b", topics: [topic] });
      assertEquals(again.id, loser.id);
      assertEquals(again.attempts, 1, "the release gave the attempt back");
      assertEquals(await processDelivery(again), {
        outcome: "skipped",
        reason: "idempotency-key-seen",
      });
      assertEquals(runs, 1);
      assert((await deliveriesForTopic(topic)).every((d) => d.status === "done"));
      const receipts = await db.selectFrom("event_handler_receipts").selectAll()
        .where("subscriptionId", "=", both[0].subscriptionId).execute();
      assertEquals(receipts.length, 1);
    } finally {
      await cleanupTopic(topic);
      _resetEventRegistryForTest();
    }
  },
);

dbTest(
  "processDelivery: an idempotency key is scoped per org, never shared across tenants",
  async () => {
    _resetEventRegistryForTest();
    const topic = uniqueTopic();
    const a = await createIsolatedUser();
    const b = await createIsolatedUser();
    const ran: string[] = [];
    try {
      registerEventHandler(topic, (e) => {
        ran.push(e.organizationId ?? "global");
      }, { name: "emailInvoice", idempotencyKey: (e) => String(e.payload.invoiceNumber) });
      await syncSubscriptionsFromRegistry();
      await publishEventAndNudge({
        topic,
        organizationId: a.org.id,
        payload: { invoiceNumber: 1001 },
      });
      await publishEventAndNudge({
        topic,
        organizationId: b.org.id,
        payload: { invoiceNumber: 1001 },
      });
      const claimed = await claimDeliveries(10, { claimedBy: "pod-a", topics: [topic] });
      for (const d of claimed) assertEquals(await processDelivery(d), { outcome: "done" });
      assertEquals(ran.sort(), [a.org.id, b.org.id].sort(), "org B's invoice 1001 is not org A's");

      // Within one org the same number IS a duplicate.
      await publishEventAndNudge({
        topic,
        organizationId: a.org.id,
        payload: { invoiceNumber: 1001 },
      });
      const [dup] = await claimDeliveries(1, { claimedBy: "pod-a", topics: [topic] });
      assertEquals(await processDelivery(dup), {
        outcome: "skipped",
        reason: "idempotency-key-seen",
      });
      assertEquals(ran.length, 2);
    } finally {
      await cleanupTopic(topic);
      await a.cleanup();
      await b.cleanup();
      _resetEventRegistryForTest();
    }
  },
);

dbTest("processDelivery: a failed attempt gives its idempotency reservation back", async () => {
  _resetEventRegistryForTest();
  const topic = uniqueTopic();
  let calls = 0;
  try {
    registerEventHandler(topic, () => {
      calls++;
      if (calls === 1) throw new Error("first try failed");
    }, { name: "retryOnce", idempotencyKey: (e) => e.key ?? e.id, retries: 2 });
    await syncSubscriptionsFromRegistry();
    await publishEventAndNudge({ topic, key: "k", payload: {} });
    const receipts = () =>
      db.selectFrom("event_handler_receipts").select(["deliveryId", "completedAt"])
        .where("idempotencyKey", "=", "global:k").execute();

    const [first] = await claimDeliveries(1, { claimedBy: "pod-a", topics: [topic] });
    assertEquals((await processDelivery(first, { random: noJitter })).outcome, "failed");
    assertEquals((await receipts()).length, 0, "no receipt for work that did not complete");

    await db.updateTable("event_deliveries").set({ nextAttemptAt: new Date(Date.now() - 1_000) })
      .where("id", "=", first.id).execute();
    const [second] = await claimDeliveries(1, { claimedBy: "pod-a", topics: [topic] });
    assertEquals(await processDelivery(second), { outcome: "done" });
    assertEquals(calls, 2, "the retry ran the handler, it was not skipped");
    const [receipt] = await receipts();
    assertEquals(receipt.deliveryId, first.id);
    assert(receipt.completedAt instanceof Date, "a completed run marks the receipt");

    // A crashed claimer's reservation goes with the stale requeue too.
    await db.updateTable("event_deliveries").set({ status: "running", claimedAt: new Date(0) })
      .where("id", "=", first.id).execute();
    assertEquals(await requeueStaleDeliveries(60_000), 1);
    assertEquals((await receipts()).length, 0);
  } finally {
    await cleanupTopic(topic);
    _resetEventRegistryForTest();
  }
});

dbTest(
  "processDelivery: an orphaned reservation (never completed, nobody running it) is taken over",
  async () => {
    _resetEventRegistryForTest();
    const topic = uniqueTopic();
    let runs = 0;
    try {
      registerEventHandler(topic, () => {
        runs++;
      }, { name: "takeover", idempotencyKey: (e) => e.key ?? e.id });
      await syncSubscriptionsFromRegistry();
      const first = await publishEventAndNudge({ topic, key: "k", payload: {} });
      const second = await publishEventAndNudge({ topic, key: "k", payload: {} });
      const [d1, d2] = await claimDeliveries(2, { claimedBy: "pod-a", topics: [topic] });
      // A reservation whose owner's cleanup write was lost: the owner row is
      // back to pending, the reservation is still there, completed_at NULL.
      await db.insertInto("event_handler_receipts")
        .values({
          subscriptionId: d1.subscriptionId,
          idempotencyKey: "global:k",
          eventId: d1.event.id,
          deliveryId: d1.id,
          completedAt: null,
        })
        .execute();
      await releaseClaims([d1]);

      assertEquals(await processDelivery(d2), { outcome: "done" });
      assertEquals(runs, 1, "the orphan must not read as a completed receipt");
      const [receipt] = await db.selectFrom("event_handler_receipts").selectAll()
        .where("idempotencyKey", "=", "global:k").execute();
      assertEquals([receipt.deliveryId, receipt.eventId], [d2.id, second.id]);
      assert(receipt.completedAt !== null);

      // And the released owner, claimed again, is now a duplicate.
      const [again] = await claimDeliveries(1, { claimedBy: "pod-b", topics: [topic] });
      assertEquals(again.event.id, first.id);
      assertEquals(await processDelivery(again), {
        outcome: "skipped",
        reason: "idempotency-key-seen",
      });
      assertEquals(runs, 1);
    } finally {
      await cleanupTopic(topic);
      _resetEventRegistryForTest();
    }
  },
);

// ── crash mid-handler ──

dbTest(
  "requeueStaleDeliveries: a claimer that died mid-handler is requeued and the attempt still counts",
  async () => {
    _resetEventRegistryForTest();
    const topic = uniqueTopic();
    try {
      registerEventHandler(topic, () => {}, { name: "crashy", retries: 1 });
      await syncSubscriptionsFromRegistry();
      await publishEventAndNudge({ topic, payload: {} });

      const [claimed] = await claimDeliveries(1, { claimedBy: "pod-that-died", topics: [topic] });
      // Simulate the pod dying: nothing calls complete or fail.
      assertEquals(await requeueStaleDeliveries(60_000), 0, "a fresh claim is not stale");
      await db.updateTable("event_deliveries").set({ claimedAt: new Date(Date.now() - 120_000) })
        .where("id", "=", claimed.id).execute();
      assertEquals(await requeueStaleDeliveries(60_000), 1);

      let [row] = await deliveriesForTopic(topic);
      assertEquals(row.status, "failed");
      assertEquals(row.attempts, 1, "the lost attempt was counted at claim time");
      assert(row.lastError?.includes("stale claim"));

      // Second claim, second death: out of attempts, so dead.
      const [second] = await claimDeliveries(1, {
        claimedBy: "pod-that-died-again",
        topics: [topic],
      });
      assertEquals(second.attempts, 2);
      await db.updateTable("event_deliveries").set({ claimedAt: new Date(Date.now() - 120_000) })
        .where("id", "=", second.id).execute();
      assertEquals(await requeueStaleDeliveries(60_000), 1);
      [row] = await deliveriesForTopic(topic);
      assertEquals(row.status, "dead");
    } finally {
      await cleanupTopic(topic);
      _resetEventRegistryForTest();
    }
  },
);

// ── boot sync ──

dbTest(
  "syncSubscriptionsFromRegistry: idempotent, updates max_attempts, deactivates removed handlers without deleting",
  async () => {
    _resetEventRegistryForTest();
    const topic = uniqueTopic();
    try {
      registerEventHandler(topic, () => {}, { name: "keep", retries: 3 });
      registerEventHandler(topic, () => {}, { name: "drop", retries: 3 });
      const one = await syncSubscriptionsFromRegistry();
      assertEquals(one.upserted, 2);
      const two = await syncSubscriptionsFromRegistry();
      assertEquals(two.upserted, 2);
      assertEquals(two.deactivated, 0);

      const before = await db.selectFrom("event_subscriptions").selectAll().where(
        "topic",
        "=",
        topic,
      )
        .orderBy("handler").execute();
      assertEquals(before.map((s) => [s.handler, s.maxAttempts, s.active]), [
        ["drop", 4, true],
        ["keep", 4, true],
      ]);

      // New code: "drop" is gone, "keep" has a bigger budget. "drop" was
      // declared moments ago (a rollout in progress), so it stays active.
      _resetEventRegistryForTest();
      registerEventHandler(topic, () => {}, { name: "keep", retries: 9 });
      const three = await syncSubscriptionsFromRegistry();
      assertEquals(three.deactivated, 0, "inside the grace window nothing is deactivated");
      let after = await db.selectFrom("event_subscriptions").selectAll().where("topic", "=", topic)
        .orderBy("handler").execute();
      assertEquals(after.map((s) => [s.handler, s.maxAttempts, s.active]), [
        ["drop", 4, true],
        ["keep", 10, true],
      ]);

      // Nobody has declared "drop" for longer than the grace window.
      const four = await syncSubscriptionsFromRegistry({ deactivateGraceMs: 0 });
      assertEquals(four.deactivated, 1);
      after = await db.selectFrom("event_subscriptions").selectAll().where("topic", "=", topic)
        .orderBy("handler").execute();
      assertEquals(after.map((s) => [s.handler, s.maxAttempts, s.active]), [
        ["drop", 4, false],
        ["keep", 10, true],
      ]);

      // A deactivated handler gets no new deliveries.
      const r = await publishEventAndNudge({ topic, payload: {} });
      assertEquals(r.deliveries, 1);
    } finally {
      await cleanupTopic(topic);
      _resetEventRegistryForTest();
    }
  },
);
