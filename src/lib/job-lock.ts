/**
 * Cross-pod job lock: run a periodic job's tick on at most one pod at a time.
 *
 * Use this for every background loop. NEVER `pg_try_advisory_lock` /
 * `pg_advisory_lock` through `db`: DATABASE_URL goes through pgbouncer in
 * transaction-pool mode, so a session lock lands on whichever server
 * connection served that statement and the unlock can land on another. The
 * lock then stays held by an idle server connection until pgbouncer recycles
 * it (up to an hour), and every tick on every pod skips. Advisory lock keys
 * are also database-wide, and many customer apps share one database with the
 * same template lock ids, so one app's tick could block another app's.
 * Observed live: 2026-08-01 (inbound-email reaper), 2026-09-04 (CDR), and
 * 2026-10-07 (Practice Builder Kit trial tags stalled until an operator
 * terminated the idle backends).
 *
 * This lock lives in Redis (`acquireLock`, prefixed per project, with a TTL),
 * so a dead holder's lock expires by itself. A timer refreshes the TTL while
 * the tick runs, so a long tick keeps it and a crashed pod frees it within
 * `ttlSeconds`. An in-process guard also stops two overlapping calls in the
 * same process, which matters when Redis is not configured (dev, tests):
 * `acquireLock` then fails open.
 *
 * The lock is exclusion for budget and duplicate sends, not a correctness
 * proof: if Redis is down, `acquireLock` fails open and two pods may both
 * run a tick. Keep job work idempotent.
 */

import { log } from "@/lib/logger.ts";
import { acquireLock, refreshLock, releaseLock } from "@/lib/redis.ts";

export type JobLockOutcome<T> = { ran: false } | { ran: true; value: T };

const runningInProcess = new Set<string>();

/**
 * Run `fn` while holding the job lock `name`. Returns `{ ran: false }`
 * without calling `fn` when another pod (or another call in this process)
 * holds it. `ttlSeconds` is how long a crashed holder blocks peers; the
 * lock is refreshed every third of it while `fn` runs.
 */
export async function withJobLock<T>(
  name: string,
  ttlSeconds: number,
  fn: () => Promise<T>,
): Promise<JobLockOutcome<T>> {
  if (runningInProcess.has(name)) return { ran: false };
  runningInProcess.add(name);
  try {
    if (!(await acquireLock(name, ttlSeconds))) return { ran: false };
    const timer = setInterval(() => {
      refreshLock(name, ttlSeconds).catch((err) => {
        log.warn(
          "job lock refresh failed (the tick keeps running)",
          { source: "job-lock", feature: "refresh", name },
          err instanceof Error ? err : new Error(String(err)),
        );
      });
    }, Math.max(1000, Math.floor((ttlSeconds * 1000) / 3)));
    Deno.unrefTimer(timer);
    try {
      return { ran: true, value: await fn() };
    } finally {
      clearInterval(timer);
      await releaseLock(name);
    }
  } finally {
    runningInProcess.delete(name);
  }
}
