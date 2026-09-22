/**
 * mcp-protocol-surface router stub (headless-monorepo-unification).
 *
 * Mounted unconditionally at `/api/mcp` (and `/api/mcp/`, matching the
 * original standalone repo's belt-and-suspenders trailing-slash mount) in
 * `app.ts` for EVERY recipe built from this monorepo, but self-gated: it
 * 404s on every request unless `ALCHEMIST_TEMPLATE_KEY=mcp-server`, so the
 * mount is inert for every other recipe. `ALCHEMIST_TEMPLATE_KEY` is a
 * platform-injected runtime env var (customer-deployment-manifest.ts), not
 * something this repo itself sets.
 *
 * This file is the ONLY thing the `mcp-protocol-surface` pack's composed
 * overlay is allowed to TOUCH for the `/api/mcp` surface (never `app.ts`
 * itself -- see the pack's file header in chipp-deno's
 * src/alchemist/services/template-packs/ for why). OAuth discovery
 * (`.well-known/*`) is a SEPARATE stub (`well-known-router.ts` in this same
 * directory), because RFC 8414/9728 require those documents at the origin
 * ROOT, not nested under `/api/mcp` -- they cannot live behind this router.
 */
import { Hono } from "hono";

export const mcpProtocolRouter = new Hono();

mcpProtocolRouter.use("*", async (c, next) => {
  if (Deno.env.get("ALCHEMIST_TEMPLATE_KEY") !== "mcp-server") return c.notFound();
  return next();
});

// mcp-protocol-surface pack-owned route registrations (mcpRoutes,
// mcpOauthRoutes) are appended below this line by that pack's composed
// overlay commit.
