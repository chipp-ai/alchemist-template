/**
 * Entry Point
 *
 * Starts the Hono server, connects to database, and handles graceful shutdown.
 */

import { app } from "./app.ts";
import { closeDatabase, initDatabase } from "@/db/client.ts";
import { reindexDocs } from "@/services/docs/reindex.ts";
import { startInboundEmailReaper, stopInboundEmailReaper } from "@/jobs/inbound-email-reaper.ts";
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

// ── In-app docs search index ──
// Reindex the docs corpus once at boot (re-embeds only changed chunks).
// Fire-and-forget + non-fatal: a reindex failure must never block serving,
// and we don't delay accepting traffic on the embedding round-trip.
reindexDocs()
  .then((r) => log.info("docs index ready", { source: "startup", ...r }))
  .catch((err) => log.warn("docs reindex skipped (non-fatal)", { source: "startup" }, err));

// ── Inbound-email extraction reaper ──
// Fire-and-forget background drain of captured inbound_email rows.
// Dormant unless DB + LLM proxy are configured AND an extraction profile
// is registered; never throws at boot. Stopped in shutdown() BEFORE
// closeDatabase() so no tick races the pool teardown.
try {
  startInboundEmailReaper();
} catch (err) {
  log.warn("inbound-email reaper failed to start (non-fatal)", { source: "startup" }, err);
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

  // Stop the background reaper BEFORE closing the database so no tick
  // races the pool teardown.
  try {
    stopInboundEmailReaper();
  } catch (err) {
    log.warn("Error stopping inbound-email reaper", { source: "shutdown" }, err);
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
