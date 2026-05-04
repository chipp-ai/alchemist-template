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

// Route imports
import { healthRoutes } from "@/api/routes/health/index.ts";
import { authRoutes } from "@/api/routes/auth/index.ts";
import { orgRoutes } from "@/api/routes/org/index.ts";
import { billingRoutes } from "@/api/routes/billing/index.ts";
import { devRoutes } from "@/api/routes/dev/index.ts";
import { fileRoutes } from "@/api/routes/files/index.ts";

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

// ── Routes ──

// Health checks (no auth required)
app.route("/", healthRoutes);

// API routes
app.route("/api/auth", authRoutes);
app.route("/api/org", orgRoutes);
app.route("/api/billing", billingRoutes);

// File storage (R2 — tenant-isolated via R2_KEY_PREFIX, see
// src/services/storage.service.ts). Auth-required. Provides
// presigned upload + download URLs so the browser can talk to R2
// directly without proxying file bytes through this server.
app.route("/api/files", fileRoutes);

// Dev-only routes (instant login + DB seeding for agent verification).
// The whole router self-404s in production via its own middleware, so
// it's safe to register unconditionally — the routes simply don't
// exist when NODE_ENV=production. See src/api/routes/dev/index.ts.
app.route("/api/dev", devRoutes);

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

  // Unexpected errors
  log.error("Unhandled error", {
    source: "app",
    path: c.req.path,
    method: c.req.method,
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
