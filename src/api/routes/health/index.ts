/**
 * Health Routes
 *
 * GET /health  - Full health check with DB status
 * GET /ready   - K8s readiness probe (200 if healthy, 503 if not)
 */

import { Hono } from "hono";
import { checkDatabaseHealth } from "@/db/client.ts";

const startTime = Date.now();

const VERSION = (() => {
  try {
    return Deno.env.get("GIT_SHA")?.slice(0, 7) ?? "dev";
  } catch {
    return "dev";
  }
})();

const healthRoutes = new Hono();

healthRoutes.get("/health", async (c) => {
  const dbStatus = await checkDatabaseHealth();
  const uptime = Math.floor((Date.now() - startTime) / 1000);

  return c.json({
    status: dbStatus === "ok" ? "ok" : "degraded",
    db: dbStatus,
    version: VERSION,
    uptime,
  });
});

healthRoutes.get("/ready", async (c) => {
  const dbStatus = await checkDatabaseHealth();
  if (dbStatus !== "ok") {
    return c.json({ status: "not ready", db: dbStatus }, 503);
  }
  return c.json({ status: "ready", db: "ok" }, 200);
});

export { healthRoutes };
