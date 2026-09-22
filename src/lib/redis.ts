/**
 * Shared Redis — best-effort cache / locks / rate limits.
 *
 * The platform provisions every deployed project with a REDIS_URL
 * pointing at a SHARED multi-tenant Redis. Your credentials are a
 * per-project ACL user confined server-side to your own key prefix
 * (REDIS_KEY_PREFIX, e.g. `customer-<projectId>:`), so nothing you do
 * here can see or touch another project's keys -- and the helpers in
 * this module prepend that prefix automatically, so application code
 * uses plain logical keys ("orders:list", "ratelimit:signup:1.2.3.4").
 *
 * THE CONTRACT (read this before using):
 *
 *   1. FAIL-OPEN, ALWAYS. Every helper returns a miss/no-op result
 *      instead of throwing when Redis is unreachable, slow (>500ms),
 *      or unconfigured. Never gate correctness on Redis: durable state
 *      belongs in Postgres. Redis is for data you can afford to lose
 *      at any moment (it is an LRU cache with no persistence).
 *   2. NEVER cache in a module-level Map instead. In-process caches
 *      silently evaporate on every deploy/restart and break the moment
 *      the app scales past one replica. If a value is worth caching
 *      across requests, it is worth `cacheGet`/`cacheSet` here.
 *   3. SCAN/KEYS are unavailable by design (the ACL denies them --
 *      they leak other tenants' key names). Track your own key sets
 *      explicitly (e.g. a Redis SET of member keys) if you need
 *      enumeration.
 *   4. Dev parity: `scripts/dev.sh` boots a local Redis and exports
 *      REDIS_URL, so this works identically in dev, the build sandbox,
 *      and production. Without REDIS_URL every helper is a silent
 *      no-op (tests run this way).
 */

import { connect, type Redis } from "redis";
import { log } from "@/lib/logger.ts";

const SOURCE = "redis";
const OP_TIMEOUT_MS = 500;
const CONNECT_TIMEOUT_MS = 3_000;
const CONNECT_RETRY_COOLDOWN_MS = 15_000;

let connPromise: Promise<Redis | null> | null = null;
let lastConnectFailAt = 0;

export function isRedisConfigured(): boolean {
  return Boolean(Deno.env.get("REDIS_URL"));
}

function keyPrefix(): string {
  return Deno.env.get("REDIS_KEY_PREFIX") ?? "";
}

/** Prefix a logical key into the tenant-scoped keyspace. */
function k(key: string): string {
  return keyPrefix() + key;
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    p,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`redis op timed out after ${ms}ms`)), ms)
    ),
  ]);
}

async function doConnect(url: string): Promise<Redis | null> {
  let dial: Promise<Redis> | null = null;
  try {
    const u = new URL(url);
    dial = connect({
      hostname: u.hostname,
      port: u.port ? Number(u.port) : 6379,
      username: u.username || undefined,
      password: u.password || undefined,
      db: (() => {
        const db = Number(u.pathname.replace("/", ""));
        return Number.isInteger(db) && db >= 0 ? db : 0;
      })(),
      // We own reconnection (drop + cooldown below); the driver's
      // internal retry would stack on top of our op timeout.
      maxRetryCount: 0,
    });
    return await withTimeout(dial, CONNECT_TIMEOUT_MS);
  } catch (err) {
    // If the timeout won the race but the dial later lands, close the
    // orphan connection instead of leaking it.
    dial?.then((c) => c.close()).catch(() => {});
    lastConnectFailAt = Date.now();
    log.warn(
      "redis: connect failed -- cache degrades to no-op until retry",
      { source: SOURCE, feature: "connect-failed" },
      err instanceof Error ? err : new Error(String(err)),
    );
    return null;
  }
}

async function getClient(): Promise<Redis | null> {
  const url = Deno.env.get("REDIS_URL");
  if (!url) return null;
  if (!connPromise) {
    // Cooldown stops a dead Redis from adding CONNECT_TIMEOUT_MS of
    // latency to every request; within the window we short-circuit.
    if (Date.now() - lastConnectFailAt < CONNECT_RETRY_COOLDOWN_MS) {
      return null;
    }
    connPromise = doConnect(url);
  }
  const client = await connPromise;
  if (client === null) connPromise = null; // allow a later retry
  return client;
}

function dropClient(): void {
  const stale = connPromise;
  connPromise = null;
  lastConnectFailAt = Date.now();
  stale?.then((c) => {
    try {
      c?.close();
    } catch {
      // already dead
    }
  });
}

/**
 * Run one bounded Redis op; any failure logs at warn, drops the
 * connection (next call reconnects after the cooldown), and yields
 * null so callers take their fail-open branch.
 */
async function run<T>(
  feature: string,
  fn: (client: Redis) => Promise<T>,
): Promise<T | null> {
  let client: Redis | null = null;
  try {
    client = await getClient();
    if (!client) return null;
    return await withTimeout(fn(client), OP_TIMEOUT_MS);
  } catch (err) {
    if (client) dropClient();
    log.warn(
      `redis: ${feature} failed (fail-open)`,
      { source: SOURCE, feature },
      err instanceof Error ? err : new Error(String(err)),
    );
    return null;
  }
}

/** Read a JSON value. null = miss OR Redis unavailable (same branch). */
export async function cacheGet<T = unknown>(key: string): Promise<T | null> {
  const raw = await run("cache-get", (c) => c.get(k(key)));
  if (raw === null || raw === undefined) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null; // foreign/corrupt value: treat as miss
  }
}

/** Write a JSON value with a TTL. Returns false when unavailable. */
export async function cacheSet(
  key: string,
  value: unknown,
  ttlSeconds: number,
): Promise<boolean> {
  const reply = await run(
    "cache-set",
    (c) => c.set(k(key), JSON.stringify(value), { ex: Math.max(1, ttlSeconds) }),
  );
  return reply === "OK";
}

/** Delete one or more keys. Returns false when unavailable. */
export async function cacheDelete(...keys: string[]): Promise<boolean> {
  if (keys.length === 0) return true;
  const deleted = await run("cache-delete", (c) => c.del(...keys.map(k)));
  return deleted !== null;
}

/**
 * Locks this process holds: name -> the owner token stored as the key's
 * value. Per-process state is right here (the holder IS this process);
 * it is not a cache. `releaseLock` and `refreshLock` read it so a caller
 * never has to carry the token around.
 */
const heldLocks = new Map<string, string>();

/** Value stored under `lock:<name>` while this process holds the lock. */
export function _heldLockTokenForTest(name: string): string | undefined {
  return heldLocks.get(name);
}

/**
 * Compare-and-run: WATCH the lock key, read it, and only when it still
 * holds `token` run `mutate` inside MULTI/EXEC. EXEC returns nil when the
 * key changed under us, so a peer's fresh lock is never touched. The ACL
 * grants @transaction but not @scripting, which is why this is WATCH
 * and not a Lua script. Returns true when the mutation was applied.
 */
async function guardedLockOp(
  feature: string,
  key: string,
  token: string,
  mutate: (tx: ReturnType<Redis["tx"]>) => void,
): Promise<boolean> {
  const applied = await run(feature, async (c) => {
    await c.watch(key);
    const current = await c.get(key);
    if (current !== token) {
      await c.unwatch();
      return false;
    }
    const tx = c.tx();
    mutate(tx);
    // The batch replies are MULTI, one QUEUED per command, then EXEC. An
    // aborted EXEC (the key changed after WATCH) is a nil reply.
    const replies = await tx.flush();
    const exec = replies[replies.length - 1];
    return Array.isArray(exec) && exec.length > 0;
  });
  return applied === true;
}

/**
 * Best-effort distributed lock (SET NX EX) with an owner token. FAIL-OPEN:
 * returns true when Redis is unavailable -- treat the lock as a
 * de-duplication optimization, never as a correctness guarantee. For
 * claiming rows of work use Postgres `FOR UPDATE SKIP LOCKED` in one
 * transaction. Do NOT reach for a Postgres advisory lock for a cross-pod
 * scheduler: behind pgbouncer's transaction pooling a dead holder's
 * session lock is never released (see the hub CLAUDE.md, "Shared
 * Redis"). This lock's TTL is what makes a dead holder harmless, so keep
 * the TTL SHORT (a minute) and call `refreshLock` from a timer while the
 * work runs; a long TTL turns every crash, OOM kill or missed release
 * into a stall of that whole length for every pod.
 *
 * The value is a random token owned by this acquisition. `releaseLock`
 * deletes the key only while it still holds that token, so a late
 * release after the TTL lapsed cannot delete a peer's lock.
 */
export async function acquireLock(
  name: string,
  ttlSeconds: number,
): Promise<boolean> {
  const client = await getClient();
  if (!client) return true; // fail-open
  const token = crypto.randomUUID();
  const reply = await run("acquire-lock", (c) =>
    c.set(k(`lock:${name}`), token, {
      ex: Math.max(1, ttlSeconds),
      mode: "NX",
    }));
  // null here means EITHER "lock held" (nil reply) or "Redis error".
  // x/redis returns undefined-ish nil for a lost NX race and "OK" for
  // a win; an op-level failure already logged and we fail-open.
  if (reply === "OK") {
    heldLocks.set(name, token);
    return true;
  }
  // Lost the race (or Redis erred). A token this process may still hold
  // for the same name stays: release and refresh compare it against the
  // key, so a stale entry is a no-op, never a wrong delete.
  return false;
}

/**
 * Extend a lock this process holds by `ttlSeconds` from now. Call it
 * from a timer while a long tick runs so the TTL can stay short. Returns
 * false when the lock is no longer ours (expired and re-taken by a peer,
 * or never held) or Redis is unavailable; the caller keeps working
 * either way, because correctness never rests on the lock.
 */
export async function refreshLock(name: string, ttlSeconds: number): Promise<boolean> {
  const token = heldLocks.get(name);
  if (token === undefined) return false;
  return await guardedLockOp(
    "refresh-lock",
    k(`lock:${name}`),
    token,
    (tx) => tx.expire(k(`lock:${name}`), Math.max(1, ttlSeconds)),
  );
}

/**
 * Release a lock taken with acquireLock. Best-effort and owner-checked:
 * the key is deleted only while it still holds our token. When the
 * shared client is in its connect cooldown (a slow op a moment ago
 * dropped it) the delete is retried once after the cooldown, so one
 * 500 ms Redis hiccup cannot leave a lock held for its whole TTL.
 */
export async function releaseLock(name: string): Promise<void> {
  const token = heldLocks.get(name);
  heldLocks.delete(name);
  if (token === undefined) return;
  const key = k(`lock:${name}`);
  const attempt = () => guardedLockOp("release-lock", key, token, (tx) => tx.del(key));
  if (await attempt()) return;
  if (!isRedisConfigured()) return;
  const inCooldown = connPromise === null &&
    Date.now() - lastConnectFailAt < CONNECT_RETRY_COOLDOWN_MS;
  if (!inCooldown) return; // the key is gone, expired, or a peer's
  const wait = CONNECT_RETRY_COOLDOWN_MS - (Date.now() - lastConnectFailAt) + 50;
  const timer = setTimeout(() => {
    attempt().catch((err) => {
      log.warn(
        "redis: deferred lock release failed (fail-open; the TTL will clear it)",
        { source: SOURCE, feature: "release-lock", name },
        err instanceof Error ? err : new Error(String(err)),
      );
    });
  }, wait);
  // Never keep the process alive for a best-effort delete.
  Deno.unrefTimer(timer);
}

/**
 * Fixed-window rate limit (INCR + EXPIRE). FAIL-OPEN: allows the
 * action when Redis is unavailable. Use for abuse damping (signup
 * attempts, webhook floods), not billing-critical quotas.
 */
export async function rateLimit(
  name: string,
  opts: { limit: number; windowSeconds: number },
): Promise<{ allowed: boolean; remaining: number }> {
  const count = await run("rate-limit", async (c) => {
    const key = k(`ratelimit:${name}`);
    const n = await c.incr(key);
    if (n === 1) await c.expire(key, Math.max(1, opts.windowSeconds));
    return n;
  });
  if (count === null) return { allowed: true, remaining: opts.limit }; // fail-open
  return {
    allowed: count <= opts.limit,
    remaining: Math.max(0, opts.limit - count),
  };
}

/**
 * Publish to a tenant-scoped pub/sub channel (the channel name is
 * prefixed like keys are). Returns receiver count, or null when
 * unavailable.
 */
export async function redisPublish(
  channel: string,
  payload: unknown,
): Promise<number | null> {
  return await run("publish", (c) => c.publish(k(channel), JSON.stringify(payload)));
}

/** A live subscription. `close()` ends it; the callback never fires again after that. */
export interface RedisSubscriptionHandle {
  close(): void;
}

/**
 * Subscribe to a tenant-scoped pub/sub channel on a DEDICATED connection
 * (a subscribed Redis connection can run no other command, so the shared
 * client is never used here). `onMessage` gets the raw message string.
 *
 * FAIL-OPEN like everything else in this module: with REDIS_URL unset
 * the handle is a no-op and nothing ever arrives; a dropped connection
 * is re-dialed after the connect cooldown until `close()` is called.
 * Callers must therefore treat a message as a hint, never as the only
 * way work gets noticed (the event consumer polls regardless).
 *
 * A throwing `onMessage` is logged and does not end the subscription.
 */
export function redisSubscribe(
  channel: string,
  onMessage: (message: string) => void,
): RedisSubscriptionHandle {
  const url = Deno.env.get("REDIS_URL");
  if (!url) return { close() {} };

  let closed = false;
  let current: { close(): void } | null = null;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;

  const scheduleRetry = () => {
    if (closed) return;
    retryTimer = setTimeout(() => {
      retryTimer = null;
      void loop();
    }, CONNECT_RETRY_COOLDOWN_MS);
  };

  const loop = async () => {
    if (closed) return;
    const client = await doConnect(url);
    if (!client) {
      scheduleRetry();
      return;
    }
    if (closed) {
      client.close();
      return;
    }
    try {
      const sub = await withTimeout(client.subscribe(k(channel)), OP_TIMEOUT_MS);
      current = { close: () => sub.close() };
      log.info("redis: subscribed", { source: SOURCE, feature: "subscribe", channel });
      for await (const { message } of sub.receive()) {
        if (closed) break;
        try {
          onMessage(message);
        } catch (err) {
          log.error(
            "redis: subscription message handler threw",
            { source: SOURCE, feature: "subscribe", channel },
            err instanceof Error ? err : new Error(String(err)),
          );
        }
      }
    } catch (err) {
      if (!closed) {
        log.warn(
          "redis: subscription dropped (fail-open; will re-dial after cooldown)",
          { source: SOURCE, feature: "subscribe", channel },
          err instanceof Error ? err : new Error(String(err)),
        );
      }
    } finally {
      current = null;
      try {
        client.close();
      } catch {
        // already closed
      }
    }
    scheduleRetry();
  };

  void loop();

  return {
    close() {
      closed = true;
      if (retryTimer !== null) {
        clearTimeout(retryTimer);
        retryTimer = null;
      }
      try {
        current?.close();
      } catch {
        // already closed
      }
    },
  };
}

/** Test seam: reset connection state (e.g. after env var changes). */
export function _resetRedisForTest(): void {
  dropClient();
  lastConnectFailAt = 0;
}
