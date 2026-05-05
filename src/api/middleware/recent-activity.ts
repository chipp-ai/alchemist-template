/**
 * Recent-activity middleware — populates the dev-panel ring buffers
 * (`src/lib/dev-activity.ts`) on every request.
 *
 * Mounted globally in `app.ts` BEFORE request-timing. No-op in
 * production: the wired routes mount it conditionally on
 * `NODE_ENV !== "production"` so the ring buffer never accumulates
 * customer-facing traffic.
 *
 * Doesn't replace the platform's NDJSON access log (request-timing).
 * They're complementary: request-timing → Loki for prod alerting;
 * recent-activity → in-memory ring for dev-panel introspection.
 */

import { createMiddleware } from "hono/factory";
import { recordRequest, recordError } from "@/lib/dev-activity.ts";

interface ActivityVariables {
  isStreaming?: boolean;
}

export const recentActivityMiddleware = createMiddleware<{
  Variables: ActivityVariables;
}>(async (c, next) => {
  const startedAt = performance.now();
  const method = c.req.method;
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

    recordRequest({
      method,
      path: c.req.path,
      routePath,
      status,
      durationMs,
      isError,
    });

    if (errorThrown !== undefined) {
      recordError({
        message: errorThrown instanceof Error
          ? errorThrown.message
          : String(errorThrown),
        stack: errorThrown instanceof Error ? errorThrown.stack : undefined,
        source: "request-timing",
        request: { method, routePath, status },
      });
    }
  }
});
