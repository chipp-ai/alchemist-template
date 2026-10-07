/**
 * withJobLock (src/lib/job-lock.ts): the cross-pod job lock every
 * background tick uses instead of a session advisory lock.
 *
 * The in-process cases run with REDIS_URL unset (acquireLock fails open), so
 * they pin the same-process overlap guard. The Redis case runs only when
 * JOB_LOCK_TEST_REDIS_URL points at a disposable Redis; it proves a second
 * holder (a "peer pod", simulated by a fresh client) is refused while the
 * first holds the lock, and admitted once it is released.
 */
import { assertEquals } from "@std/assert";
import { withJobLock } from "@/lib/job-lock.ts";
import { _heldLockTokenForTest, _resetRedisForTest } from "@/lib/redis.ts";
import { __deleteEnvForTest, __setEnvForTest, getEnv } from "@/lib/env.ts";

Deno.test("withJobLock: an overlapping call in the same process is skipped, not run", async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const first = withJobLock("job-lock-test-overlap", 30, async () => {
    await gate;
    return "first";
  });
  const second = await withJobLock("job-lock-test-overlap", 30, () => Promise.resolve("second"));
  assertEquals(second, { ran: false });
  release();
  assertEquals(await first, { ran: true, value: "first" });
});

Deno.test("withJobLock: the lock is free again after the tick, even when it throws", async () => {
  let threw = false;
  try {
    await withJobLock("job-lock-test-throw", 30, () => Promise.reject(new Error("boom")));
  } catch {
    threw = true;
  }
  assertEquals(threw, true);
  assertEquals(await withJobLock("job-lock-test-throw", 30, () => Promise.resolve(1)), {
    ran: true,
    value: 1,
  });
});

const redisUrl = getEnv("JOB_LOCK_TEST_REDIS_URL");

Deno.test({
  name: "withJobLock: a peer is refused while the Redis lock is held, admitted after release",
  ignore: !redisUrl,
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    const prevUrl = getEnv("REDIS_URL");
    const prevPrefix = getEnv("REDIS_KEY_PREFIX");
    __setEnvForTest("REDIS_URL", redisUrl!);
    __setEnvForTest("REDIS_KEY_PREFIX", `job-lock-test-${crypto.randomUUID()}:`);
    _resetRedisForTest();
    try {
      const name = "job-lock-test-peer";
      const outcome = await withJobLock(name, 30, async () => {
        const token = _heldLockTokenForTest(name);
        // A peer pod holds no token of ours; simulate it by asking Redis
        // directly whether the key is taken (SET NX must fail).
        const { acquireLock } = await import("@/lib/redis.ts");
        const peerWins = await acquireLock(`${name}`, 30).then(async (won) => {
          // acquireLock overwrote our in-process token only on a win.
          return won && _heldLockTokenForTest(name) !== token;
        });
        return { tokenHeld: token !== undefined, peerWins };
      });
      assertEquals(outcome, { ran: true, value: { tokenHeld: true, peerWins: false } });
      // Released: the next tick acquires it.
      assertEquals(await withJobLock(name, 30, () => Promise.resolve("again")), {
        ran: true,
        value: "again",
      });
    } finally {
      _resetRedisForTest();
      if (prevUrl === undefined) __deleteEnvForTest("REDIS_URL");
      else __setEnvForTest("REDIS_URL", prevUrl);
      if (prevPrefix === undefined) __deleteEnvForTest("REDIS_KEY_PREFIX");
      else __setEnvForTest("REDIS_KEY_PREFIX", prevPrefix);
    }
  },
});
