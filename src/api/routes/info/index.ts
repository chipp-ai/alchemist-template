/**
 * Info Routes
 *
 * GET /  - Template metadata (no auth)
 *
 * Returns the template name and the build-time git SHA. The
 * git_sha key is intentionally snake_case to match the ticket
 * spec verbatim, even though the rest of the API tends toward
 * camelCase. The value is the RAW GIT_SHA (no 7-char slice) —
 * this differs from /health's `version` field on purpose.
 */

import { Hono } from "hono";

const TEMPLATE_NAME = "alchemist-template";

const GIT_SHA = (() => {
  try {
    return Deno.env.get("GIT_SHA") ?? "dev";
  } catch {
    return "dev";
  }
})();

const infoRoutes = new Hono();

infoRoutes.get("/", (c) => {
  return c.json({
    template: TEMPLATE_NAME,
    git_sha: GIT_SHA,
  });
});

export { infoRoutes };
