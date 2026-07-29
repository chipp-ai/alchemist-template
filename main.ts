/**
 * Entry Point
 *
 * Starts the Hono server, connects to database, and handles graceful shutdown.
 */

import { app } from "./app.ts";
import { closeDatabase, initDatabase } from "@/db/client.ts";
import { reindexDocs } from "@/services/docs/reindex.ts";
import { startInboundEmailReaper, stopInboundEmailReaper } from "@/jobs/inbound-email-reaper.ts";
import { startDemoReseedLoop, stopDemoReseedLoop } from "@/jobs/demo-reseed-loop.ts";
import { log } from "@/lib/logger.ts";
import { assertNoLiveStripeKeyInDemoMode } from "@/lib/stripe.ts";
import { isDemoMode } from "@/config/demo-mode.ts";
import { getWorkerRole, roleRunsBackgroundWork } from "@/lib/worker-role.ts";

const port = parseInt(Deno.env.get("PORT") ?? "8000");
const nodeEnv = Deno.env.get("NODE_ENV") ?? "development";
const version = Deno.env.get("GIT_SHA")?.slice(0, 7) ?? "dev";

// ── DEMO_MODE boot guard ──
// Refuse to start if this public demo could charge real money via a
// live-mode Stripe key. Fatal by design -- unlike every other boot step
// in this file, this one is NOT best-effort, because the failure mode it
// prevents is real charges.
if (isDemoMode()) {
  log.info("DEMO_MODE=1 -- running as a public demo deployment", { source: "startup" });
  try {
    assertNoLiveStripeKeyInDemoMode();
  } catch (err) {
    log.error("Refusing to start: live Stripe key detected under DEMO_MODE", {
      source: "startup",
    }, err as Error);
    Deno.exit(1);
  }
}

// ── Database connection ──

try {
  await initDatabase();
} catch (_err) {
  log.error("Failed to connect to database on startup", {
    source: "startup",
  }, _err);
  // Continue running -- health endpoint will report degraded
}

// ── Role split (WORKER_ROLE) ──
// When the project declares a `worker:` block in .alchemist/deployment.yaml the
// platform runs this SAME image as two pods: `api` (serves traffic) and
// `worker` (runs background work). Every periodic loop below must run in
// exactly one of them or each tick happens twice -- the inbound-email reaper
// claims rows safely, so a duplicate tick does not corrupt data, but it does
// re-pay for the LLM extraction every time.
//
// Resolves to "all" (runs everything) when WORKER_ROLE is absent, which is the
// single-pod default and the majority of deployments. HTTP is NOT gated: both
// roles serve, because the worker pod has its own readiness probe.
const workerRole = getWorkerRole();
const runsBackgroundWork = roleRunsBackgroundWork();
log.info("Worker role resolved", {
  source: "startup",
  workerRole,
  runsBackgroundWork,
});

// ── In-app docs search index ──
// Reindex the docs corpus once at boot (re-embeds only changed chunks).
// Fire-and-forget + non-fatal: a reindex failure must never block serving,
// and we don't delay accepting traffic on the embedding round-trip.
if (runsBackgroundWork) {
  reindexDocs()
    .then((r) => log.info("docs index ready", { source: "startup", ...r }))
    .catch((err) => log.warn("docs reindex skipped (non-fatal)", { source: "startup" }, err));
}

// ── Inbound-email extraction reaper ──
// Fire-and-forget background drain of captured inbound_email rows.
// Dormant unless DB + LLM proxy are configured AND an extraction profile
// is registered; never throws at boot. Stopped in shutdown() BEFORE
// closeDatabase() so no tick races the pool teardown.
if (runsBackgroundWork) {
  try {
    startInboundEmailReaper();
  } catch (err) {
    log.warn("inbound-email reaper failed to start (non-fatal)", { source: "startup" }, err);
  }
}

// ── Demo nightly re-seed loop ──
// Fire-and-forget background re-seed of the DEMO_MODE demo content.
// Dormant unless DEMO_MODE=1 AND the database is configured; never throws
// at boot. Stopped in shutdown() BEFORE closeDatabase() so no tick races
// the pool teardown.
if (runsBackgroundWork) {
  try {
    startDemoReseedLoop();
  } catch (err) {
    log.warn("demo reseed loop failed to start (non-fatal)", { source: "startup" }, err);
  }
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
    stopDemoReseedLoop();
  } catch (err) {
    log.warn("Error stopping demo reseed loop", { source: "shutdown" }, err);
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
