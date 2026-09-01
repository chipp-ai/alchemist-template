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
 * Best-effort distributed lock (SET NX EX). FAIL-OPEN: returns true
 * when Redis is unavailable -- treat the lock as a de-duplication
 * optimization, never as a correctness guarantee. For real mutual
 * exclusion use a Postgres advisory lock or a row-level lock.
 */
export async function acquireLock(
  name: string,
  ttlSeconds: number,
): Promise<boolean> {
  const client = await getClient();
  if (!client) return true; // fail-open
  const reply = await run("acquire-lock", (c) =>
    c.set(k(`lock:${name}`), "1", {
      ex: Math.max(1, ttlSeconds),
      mode: "NX",
    }));
  // null here means EITHER "lock held" (nil reply) or "Redis error".
  // x/redis returns undefined-ish nil for a lost NX race and "OK" for
  // a win; an op-level failure already logged and we fail-open.
  return reply === "OK";
}

/** Release a lock taken with acquireLock. Best-effort. */
export async function releaseLock(name: string): Promise<void> {
  await run("release-lock", (c) => c.del(k(`lock:${name}`)));
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

/** Test seam: reset connection state (e.g. after env var changes). */
export function _resetRedisForTest(): void {
  dropClient();
  lastConnectFailAt = 0;
}
