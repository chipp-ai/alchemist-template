/**
 * Health Routes
 *
 * GET /health  - Health check with DB status
 * GET /ready   - K8s readiness probe (200 if healthy, 503 if not)
 * GET /live    - Process-only liveness (never touches the database)
 *
 * The platform's readiness probe hits /health every 2 seconds and the load
 * balancer's health check every 3. A database query on each one kept the
 * pool's server connection busy forever, so an idle app still held a
 * connection on the shared database (Chipp platform design
 * docs/implementation-plans/project-db-scaling/design.md, 1b). A healthy DB
 * check is therefore remembered for HEALTH_DB_CACHE_MS; an unhealthy one is
 * never remembered, so a recovery shows on the next probe and the startup
 * probe still proves the database on boot. Between real checks no query
 * runs, the pooler's idle timeout (60 s) closes the server connection, and
 * an idle app costs the database nothing.
 */

import { Hono } from "hono";
import { checkDatabaseHealth } from "@/db/client.ts";
import { getEnv } from "@/lib/env.ts";

/** How long a healthy database check is reused. Longer than the pooler's 60 s idle timeout. */
export const HEALTH_DB_CACHE_MS = 5 * 60_000;

const startTime = Date.now();

const VERSION = (() => {
  try {
    return getEnv("GIT_SHA")?.slice(0, 7) ?? "dev";
  } catch {
    return "dev";
  }
})();

type DbStatus = "ok" | "degraded";

/** A database check that reuses a healthy answer for `ttlMs`. Exported for tests. */
export function cachedDatabaseCheck(
  check: () => Promise<DbStatus> = checkDatabaseHealth,
  now: () => number = Date.now,
  ttlMs: number = HEALTH_DB_CACHE_MS,
): () => Promise<DbStatus> {
  let okUntil = 0;
  let inFlight: Promise<DbStatus> | null = null;
  return async () => {
    if (now() < okUntil) return "ok";
    // One query at a time: concurrent probes share it.
    inFlight ??= check().finally(() => {
      inFlight = null;
    });
    const status = await inFlight;
    if (status === "ok") okUntil = now() + ttlMs;
    return status;
  };
}

export function createHealthRoutes(dbCheck: () => Promise<DbStatus> = cachedDatabaseCheck()): Hono {
  const routes = new Hono();

  routes.get("/health", async (c) => {
    const dbStatus = await dbCheck();
    const uptime = Math.floor((Date.now() - startTime) / 1000);
    return c.json({
      status: dbStatus === "ok" ? "ok" : "degraded",
      db: dbStatus,
      version: VERSION,
      uptime,
    });
  });

  routes.get("/ready", async (c) => {
    const dbStatus = await dbCheck();
    if (dbStatus !== "ok") {
      return c.json({ status: "not ready", db: dbStatus }, 503);
    }
    return c.json({ status: "ready", db: "ok" }, 200);
  });

  routes.get("/live", (c) => c.json({ status: "ok", version: VERSION }));

  return routes;
}

const healthRoutes = createHealthRoutes();

export { healthRoutes };
