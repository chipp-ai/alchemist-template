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
import { logger } from "hono/logger";
import { serveStatic } from "hono/deno";
import { AppError } from "@/utils/errors.ts";
import { log } from "@/lib/logger.ts";

// Route imports
import { healthRoutes } from "@/api/routes/health/index.ts";
import { authRoutes } from "@/api/routes/auth/index.ts";
import { orgRoutes } from "@/api/routes/org/index.ts";
import { billingRoutes } from "@/api/routes/billing/index.ts";

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

// Request logger (dev only)
const IS_DEV = Deno.env.get("NODE_ENV") !== "production";
if (IS_DEV) {
  app.use("*", logger());
}

// ── Routes ──

// Health checks (no auth required)
app.route("/", healthRoutes);

// API routes
app.route("/api/auth", authRoutes);
app.route("/api/org", orgRoutes);
app.route("/api/billing", billingRoutes);

// ── Static SPA ──
// Serves the Svelte frontend built in the Dockerfile's web-builder stage
// (output goes to web/dist/). Mounted AFTER the API routes so /api/*
// requests still hit their handlers, and BEFORE app.notFound so visiting
// the customer URL in a browser returns the SPA shell instead of the
// API's JSON 404 fallback. The second line is the SPA fallback — any
// path that doesn't match a static file (e.g. /feed deep links on hard
// refresh) gets index.html so the client-side router can resolve it.
app.use("/*", serveStatic({ root: "./web/dist" }));
app.use("/*", serveStatic({ path: "./web/dist/index.html" }));

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
