/**
 * Request-timing middleware
 *
 * Emits one NDJSON log line per request via the platform logger, so
 * Grafana/Loki can:
 *
 *   - alert on error rate via the `level=error` stream label
 *     (Promtail extracts it from the `level` JSON field)
 *   - alert on p95 latency degradation by aggregating the `duration_ms`
 *     field per route via Loki's `quantile_over_time` LogQL function
 *   - feed the per-customer Grafana dashboards (request rate / p50/p95/p99
 *     latency / error rate) without any per-route boilerplate.
 *
 * The platform's customer-observability pipeline keys off two things in
 * each emitted record: `source: "performance"` (so the alert query
 * filters cleanly) and `level: "error"` for any response with status
 * >= 500 (so the existing `{namespace="alchemist-customers", level="error"}`
 * alert rule matches access-log 5xx without the customer having to
 * remember to log.error in their own catch blocks).
 *
 * SSE / streaming responses are flagged via `c.set("isStreaming", true)`
 * inside the route handler so this middleware can mark them
 * `isStreaming: true` in the log line. The alerting rules exclude
 * streamed responses from latency percentile windows (a 60s SSE chat
 * shouldn't trigger a latency alert).
 */

import { createMiddleware } from "hono/factory";
import { log } from "@/lib/logger.ts";

interface TimingVariables {
  /** Route handlers can opt-out of latency tracking by setting this. */
  isStreaming?: boolean;
}

export const requestTimingMiddleware = createMiddleware<{
  Variables: TimingVariables;
}>(async (c, next) => {
  const startedAt = performance.now();
  const method = c.req.method;
  // `c.req.routePath` is Hono's matched route pattern (e.g. `/api/boards/:id`).
  // Falls back to the raw path for not-yet-matched / 404 cases — those land
  // on `app.notFound` which means Hono didn't pick a route. Using the raw
  // path there avoids losing 404s from the access log.
  // deno-lint-ignore no-explicit-any
  const routePath = (c.req as any).routePath ?? c.req.path;

  let errorThrown: unknown = undefined;
  try {
    await next();
  } catch (err) {
    errorThrown = err;
    throw err;
  } finally {
    const durationMs = Math.round((performance.now() - startedAt) * 100) / 100;
    const status = c.res?.status ?? (errorThrown ? 500 : 200);
    const isError = status >= 500 || errorThrown !== undefined;
    const isStreaming = c.get("isStreaming") === true;

    const ctx = {
      source: "performance" as const,
      feature: "request-timing" as const,
      method,
      route: routePath,
      path: c.req.path,
      status,
      duration_ms: durationMs,
      isStreaming,
    };

    if (isError) {
      log.error(
        `${method} ${routePath} ${status} ${durationMs}ms`,
        ctx,
        errorThrown,
      );
    } else if (status >= 400) {
      // 4xx is client error — log at warn so it doesn't trip error
      // alerts (a malformed signup request is the user's bug, not ours)
      // but is still queryable for support.
      log.warn(`${method} ${routePath} ${status} ${durationMs}ms`, ctx);
    } else {
      log.info(`${method} ${routePath} ${status} ${durationMs}ms`, ctx);
    }
  }
});
