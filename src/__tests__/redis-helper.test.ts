/**
 * Tests for the shared-Redis helper's FAIL-OPEN contract. The test env
 * never sets REDIS_URL, so these pin the unconfigured/no-op branch --
 * the same branch production takes during a Redis outage. If a future
 * change makes any helper THROW (or block) without Redis, application
 * code written against the fail-open contract breaks in ways that only
 * surface during an outage; these tests catch it in CI instead.
 */

import { assert, assertEquals } from "@std/assert";
import {
  _resetRedisForTest,
  acquireLock,
  cacheDelete,
  cacheGet,
  cacheSet,
  isRedisConfigured,
  rateLimit,
  redisPublish,
  releaseLock,
} from "@/lib/redis.ts";

Deno.test("redis helpers: unconfigured env is a silent no-op", async () => {
  const saved = Deno.env.get("REDIS_URL");
  try {
    Deno.env.delete("REDIS_URL");
    _resetRedisForTest();

    assertEquals(isRedisConfigured(), false);
    assertEquals(await cacheGet("some:key"), null);
    assertEquals(await cacheSet("some:key", { a: 1 }, 60), false);
    assertEquals(await cacheDelete("some:key"), false);
    // Locks + rate limits FAIL OPEN: the action proceeds.
    assertEquals(await acquireLock("job", 30), true);
    await releaseLock("job"); // must not throw
    const rl = await rateLimit("signup:1.2.3.4", {
      limit: 5,
      windowSeconds: 60,
    });
    assertEquals(rl.allowed, true);
    assertEquals(await redisPublish("events", { hello: true }), null);
  } finally {
    if (saved !== undefined) Deno.env.set("REDIS_URL", saved);
    _resetRedisForTest();
  }
});

Deno.test({
  name: "redis helpers: unreachable REDIS_URL fails open (bounded, no throw)",
  // The scenario under test IS an abandoned TCP dial (the helper's
  // connect timeout fires and the OS-level dial to the blackhole
  // address stays in flight past test end). The helper closes the
  // orphan if it ever lands; the sanitizer can't know that.
  sanitizeOps: false,
  sanitizeResources: false,
}, async () => {
  const saved = Deno.env.get("REDIS_URL");
  try {
    // TEST-NET-1 address: connect attempts fail fast or time out at the
    // helper's 3s connect bound; every call after the first failure
    // short-circuits on the retry cooldown.
    Deno.env.set("REDIS_URL", "redis://192.0.2.1:6379");
    _resetRedisForTest();

    assertEquals(isRedisConfigured(), true);
    const started = Date.now();
    assertEquals(await cacheGet("some:key"), null);
    const rl = await rateLimit("x", { limit: 1, windowSeconds: 1 });
    assert(rl.allowed);
    // First call pays at most the connect timeout; the second is a
    // cooldown short-circuit. Generous bound so slow CI never flakes.
    assert(Date.now() - started < 10_000);
  } finally {
    if (saved !== undefined) Deno.env.set("REDIS_URL", saved);
    else Deno.env.delete("REDIS_URL");
    _resetRedisForTest();
  }
});
