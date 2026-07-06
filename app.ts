/**
 * Hono Application Setup
 *
 * Registers global middleware, mounts routes, and configures error handling.
 */

import { Hono } from "hono";
import { cors } from "hono/cors";
import { secureHeaders } from "hono/secure-headers";
import { compress } from "hono/compress";
import { timing } from "hono/timing";
import { serveStatic } from "hono/deno";
import { AppError } from "@/utils/errors.ts";
import { log } from "@/lib/logger.ts";
import { requestTimingMiddleware } from "@/api/middleware/request-timing.ts";
import { recentActivityMiddleware } from "@/api/middleware/recent-activity.ts";

// Route imports
import { healthRoutes } from "@/api/routes/health/index.ts";
import { authRoutes } from "@/api/routes/auth/index.ts";
import { orgRoutes } from "@/api/routes/org/index.ts";
import { billingRoutes } from "@/api/routes/billing/index.ts";
import { devRoutes } from "@/api/routes/dev/index.ts";
import { fileRoutes } from "@/api/routes/files/index.ts";
import { inviteRoutes } from "@/api/routes/invite/index.ts";
import { realtimeRoutes } from "@/api/routes/realtime/index.ts";
import { observabilityRoutes } from "@/api/routes/observability/index.ts";
import { docsRoutes } from "@/api/routes/docs/index.ts";
import { ingestEmailRoutes } from "@/api/routes/ingest-email/index.ts";
import { inboundEmailRoutes } from "@/api/routes/inbound-emails/index.ts";
import { devRoutesEnabled } from "@/lib/dev-mode.ts";

// ── App types ──

import type { AuthUser } from "@/api/middleware/auth.ts";

type AppEnv = {
  Variables: {
    requestId: string;
    user: AuthUser;
    organizationId: string;
  };
};

// ── App instance ──

const app = new Hono<AppEnv>();

// ── Global middleware ──

// Request ID
app.use("*", async (c, next) => {
  const requestId = c.req.header("x-request-id") ?? crypto.randomUUID();
  c.set("requestId", requestId);
  c.header("X-Request-Id", requestId);
  await next();
});

// CORS
app.use(
  "*",
  cors({
    origin: (origin) => origin, // reflect origin for dev; tighten in production
    credentials: true,
    allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowHeaders: ["Content-Type", "Authorization"],
  }),
);

// Security headers
app.use("*", secureHeaders());

// Compression
app.use("*", compress());

// Timing (Server-Timing header)
app.use("*", timing());

// Request-timing middleware — emits one NDJSON log line per request
// via the platform logger so Loki/Grafana can alert on error rate +
// p95 latency degradation. Mounted AFTER the body-touching middleware
// (CORS / secureHeaders / compress / timing) so it sees the final
// status the client receives, not the pre-mutation one.
app.use("*", requestTimingMiddleware);

// Recent-activity middleware — populates the in-memory ring buffers
// (src/lib/dev-activity.ts) consumed by /api/dev/app-state and the
// in-browser DevPanel. Gated on the FAIL-CLOSED dev flag (see
// lib/dev-mode.ts) so the ring buffer never accumulates customer-facing
// traffic unless dev routes are explicitly enabled. Matches the gate on
// the dev-routes router that EXPOSES this data.
if (devRoutesEnabled()) {
  app.use("*", recentActivityMiddleware);
}

// ── Routes ──

// Health checks (no auth required)
app.route("/", healthRoutes);

// API routes
app.route("/api/auth", authRoutes);
app.route("/api/org", orgRoutes);
app.route("/api/billing", billingRoutes);

// In-app docs section + semantic search. Auth-required (docs are
// internal). Content is static (the registry); search is served from
// the boot-built index (src/services/docs/). See docs/in-app/.
app.route("/api/docs", docsRoutes);

// File storage (R2 — tenant-isolated via R2_KEY_PREFIX, see
// src/services/storage.service.ts). Auth-required. Provides
// presigned upload + download URLs so the browser can talk to R2
// directly without proxying file bytes through this server.
app.route("/api/files", fileRoutes);

// Invite acceptance (public preview + auth-required accept). NOT
// nested under /api/org because invitees aren't bound to an org yet
// when they hit these endpoints. See src/api/routes/invite/index.ts.
app.route("/api/invite", inviteRoutes);

// Inbound-email ingestion (Postmark webhook -> durable capture). Token-
// gated (INGEST_EMAIL_TOKEN, fail-closed), NOT session auth -- the caller
// is Postmark. Dormant until the token is configured. See
// src/api/routes/ingest-email/index.ts.
app.route("/api/ingest/email", ingestEmailRoutes);

// Inbound-email dashboard reads (auth-required, org-scoped). See
// src/api/routes/inbound-emails/index.ts.
app.route("/api/inbound-emails", inboundEmailRoutes);

// Realtime / WebSocket. Auth via short-lived ws-token (issued from
// GET /api/auth/ws-token). The baseline route echoes messages so
// customers can replace the on-message branch with their own
// dispatch (chat, presence, live cursors).
app.route("/api/realtime", realtimeRoutes);

// Dev-only routes (instant login + DB seeding for agent verification).
// The whole router self-404s in production via its own middleware, so
// it's safe to register unconditionally — the routes simply don't
// exist when NODE_ENV=production. See src/api/routes/dev/index.ts.
app.route("/api/dev", devRoutes);

// Observability collector — receives batched client breadcrumbs and
// writes to the unified .scratch/logs/observability.jsonl stream.
// Dev-only by virtue of recordClientEvents being a no-op in prod,
// but the route mount stays unconditional so a misconfigured
// NODE_ENV doesn't break the SPA's breadcrumb POSTs with 404s. See
// src/observability/envelope.ts.
app.route("/api/_observability", observabilityRoutes);

// ── Static SPA ──
// Serves the Svelte frontend built in the Dockerfile's web-builder stage
// (output goes to web/dist/). Mounted AFTER the API routes so /api/*
// requests still hit their handlers, and BEFORE app.notFound so visiting
// the customer URL in a browser returns the SPA shell instead of the
// API's JSON 404 fallback.
//
// The SPA fallback (line 2 below) MUST exclude /api/* paths — Hono's
// serveStatic with `path:` matches every unmatched route, so without
// this gate it would intercept malformed API requests and return the
// SPA shell with a 200 status, swallowing real 4xx/5xx from API
// handlers. The first-line bare-asset serveStatic is already path-
// scoped (only matches when web/dist/<path> exists), so it's safe.
app.use("/*", serveStatic({ root: "./web/dist" }));
app.use("/*", async (c, next) => {
  // /api/* requests must NOT receive the SPA shell — they need to
  // surface real 4xx/5xx + JSON bodies to the SPA fetch caller.
  if (c.req.path.startsWith("/api/")) return next();
  return serveStatic({ path: "./web/dist/index.html" })(c, next);
});

// ── Global error handler ──

app.onError((err, c) => {
  // AppError subclasses carry their own status code
  if (err instanceof AppError) {
    return c.json(
      { error: err.message, code: err.code },
      err.statusCode,
    );
  }

  // Unexpected errors. The requestId carries through every log on
  // this request and into the X-Request-Id response header, so
  // operators (and the autonomous self-healing pipeline) can trace
  // a 500 a user reports back to the exact server-side stack trace.
  log.error("Unhandled error", {
    source: "app",
    feature: "unhandled-error",
    path: c.req.path,
    method: c.req.method,
    requestId: c.get("requestId"),
  }, err);

  return c.json(
    { error: "Internal server error", code: "INTERNAL_ERROR" },
    500,
  );
});

// ── 404 handler ──

app.notFound((c) => {
  return c.json({ error: "Not found", code: "NOT_FOUND" }, 404);
});

export { app };
export type { AppEnv };
