/**
 * Entry Point
 *
 * Starts the Hono server, connects to database, and handles graceful shutdown.
 */

import { app } from "./app.ts";
import { initDatabase, closeDatabase } from "@/db/client.ts";
import { log } from "@/lib/logger.ts";

const port = parseInt(Deno.env.get("PORT") ?? "8000");
const nodeEnv = Deno.env.get("NODE_ENV") ?? "development";
const version = Deno.env.get("GIT_SHA")?.slice(0, 7) ?? "dev";

// ── Database connection ──

try {
  await initDatabase();
} catch (_err) {
  log.error("Failed to connect to database on startup", {
    source: "startup",
  }, _err);
  // Continue running -- health endpoint will report degraded
}

// ── Start server ──

log.info("Server starting", {
  source: "startup",
  port,
  nodeEnv,
  version,
});

const server = Deno.serve({ port }, app.fetch);

// ── Graceful shutdown ──

let shuttingDown = false;

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;

  log.info(`Received ${signal}, starting graceful shutdown`, {
    source: "shutdown",
    signal,
  });

  try {
    // Stop accepting new connections
    await server.shutdown();
    log.info("HTTP server drained", { source: "shutdown" });
  } catch (err) {
    log.warn("Error draining HTTP server", { source: "shutdown" }, err);
  }

  try {
    await closeDatabase();
  } catch (err) {
    log.warn("Error closing database", { source: "shutdown" }, err);
  }

  log.info("Shutdown complete", { source: "shutdown" });
}

Deno.addSignalListener("SIGTERM", () => shutdown("SIGTERM"));
Deno.addSignalListener("SIGINT", () => shutdown("SIGINT"));
