# Shared Redis

## Shared Redis — cache, locks, rate limits (best-effort)

The platform provisions every deployed project with `REDIS_URL` pointing at a
shared multi-tenant Redis. Your credentials are a per-project Redis ACL user
confined server-side to your own key prefix (`REDIS_KEY_PREFIX`), so you can
never see or touch another project's keys. **Always go through the helpers in
`src/lib/redis.ts`** -- they prepend the prefix automatically, bound every op
at 500ms, and fail open:

```ts
import { cacheGet, cacheSet, cacheDelete, acquireLock, releaseLock, rateLimit } from "@/lib/redis.ts";

// Cache an expensive lookup for 60s
const cached = await cacheGet<Report>(`report:${id}`);
if (cached) return cached;
const report = await buildReport(id);
await cacheSet(`report:${id}`, report, 60);

// Damp abuse on a public endpoint
const rl = await rateLimit(`signup:${ip}`, { limit: 5, windowSeconds: 3600 });
if (!rl.allowed) return c.json({ error: "Too many attempts" }, 429);

// De-duplicate a background job across restarts
if (await acquireLock("nightly-report", 300)) {
  try { await runNightlyReport(); } finally { await releaseLock("nightly-report"); }
}
```

### When Redis is the answer, and when it is not

Reach for Redis when the ticket or message involves any of these:

- **A scheduled tick, poller, reaper or sweep** (`setInterval`, cron, "every
  N minutes", "sync", "poll", "reconcile"). It runs on every replica and on
  both pods during a rolling deploy, so it double-runs unless one
  `acquireLock` guards the tick. Name the lock key and a TTL longer than the
  worst-case tick in the plan.
- **A public endpoint someone could hammer** (signup, login, contact form,
  webhook receiver, search): `rateLimit`.
- **A webhook or inbound message that a provider may deliver twice**: dedup
  on the provider's message id with a short TTL, then process.
- **An expensive read that many requests repeat** (a report, an external API
  lookup, a rendered fragment): `cacheGet` / `cacheSet` with a TTL. Cache
  the result, never the decision.
- **A short-lived secret** (one-time code, magic link nonce, upload session):
  `cacheSet` with the TTL as the expiry.

Do not reach for Redis when:

- **Losing it would be a bug.** No persistence, LRU eviction. Orders, ledger
  rows, audit trails, anything a person will ask about later: Postgres.
- **It is a queue of work.** Rows in Postgres plus a poller that claims with
  `FOR UPDATE SKIP LOCKED`. Redis lists lose items on eviction.
- **It is per-request memoization.** A local variable inside the handler is
  fine and needs no Redis.
- **You want to know what keys exist.** `SCAN` is denied; track them yourself.

The rules:

- **Redis is a CACHE, never a source of truth.** It runs with LRU eviction and
  no persistence; any key can vanish at any moment. Durable state (including
  anything billing- or correctness-critical) belongs in Postgres. Every helper
  fails OPEN -- a Redis outage degrades to cache misses / allowed actions, it
  never takes your app down. Never gate correctness on a Redis reply.
- **Never use a module-level `Map` (or any in-process memo) for state that
  must survive a restart or be shared across requests.** In-memory state
  silently evaporates on every deploy and breaks the moment the app scales
  past one replica. If it is worth caching across requests, use `cacheGet` /
  `cacheSet`. (Per-request memoization inside one handler call is fine.)
- **Locks and rate limits are damping, not guarantees.** `acquireLock` and
  `rateLimit` fail open when Redis is unavailable, so a Redis outage means a
  tick may double-run once, never that the app stops. That is the intended
  trade. For claiming individual rows (a queue of work), use Postgres
  `SELECT ... FOR UPDATE SKIP LOCKED` inside one transaction; that is safe
  under transaction pooling because the lock and the work share a
  transaction.
- **Never take a Postgres advisory lock (`pg_try_advisory_lock`,
  `pg_advisory_lock`) for a cross-pod scheduler, poller or reaper.** Your
  `DATABASE_URL` goes through pgbouncer in transaction-pool mode. An advisory
  lock is session-scoped, so when the pod holding it dies mid-tick the lock
  stays held on an orphaned backend connection until someone finds it in
  `pg_locks` and terminates the backend. The scheduler then silently never
  runs again on any replica. This happened in production (a carrier-sync
  scheduler jammed for hours, 2026-08-01) and the same bug existed in 22
  other schedulers in that project. `acquireLock` (Redis `SET NX EX` with a
  TTL) is the cross-pod lock. A dead holder's lock expires on its own. For a
  job tick, wrap the work in `withJobLock(name, ttlSeconds, fn)` from
  `src/lib/job-lock.ts`: it takes the Redis lock, refreshes it while `fn`
  runs, releases it, and guards same-process overlap. A source scan
  (`src/__tests__/no-session-advisory-lock.test.ts`) fails the build on any
  `pg_try_advisory_lock(` / `pg_advisory_lock(` outside test provisioning.
- **Key a per-IP limit on `clientIp()` from `src/lib/client-ip.ts`** (Cloudflare's
  `cf-connecting-ip`), never the first `X-Forwarded-For` entry or a cookie: the
  caller writes both. A limit that must hold (money, auth, mail) cannot be only
  this fail-open limiter: back it with an atomic Postgres statement (a
  conditional `UPDATE ... RETURNING` or a unique constraint).
- **`SCAN`/`KEYS` are denied by the ACL** (they would leak other tenants' key
  names). If you need to enumerate your own keys, track them explicitly in a
  Redis SET or in Postgres.
- **Dev parity:** `scripts/dev.sh` boots a local Redis and exports
  `REDIS_URL`, so behavior matches production. With `REDIS_URL` unset (tests),
  every helper is a silent no-op.
