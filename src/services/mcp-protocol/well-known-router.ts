/**
 * mcp-protocol-surface OAuth discovery stub (headless-monorepo-unification).
 *
 * Mounted unconditionally at `/.well-known` in `app.ts` for EVERY recipe
 * built from this monorepo, but self-gated: it 404s on every request
 * unless `ALCHEMIST_TEMPLATE_KEY=mcp-server`, so the mount is inert for
 * every other recipe.
 *
 * SEPARATE from `router.ts` in this same directory (which owns `/api/mcp`)
 * because RFC 8414 (`/.well-known/oauth-authorization-server`) and RFC 9728
 * (`/.well-known/oauth-protected-resource`) require these documents at the
 * origin ROOT -- nesting them under `/api/mcp` would break OAuth discovery
 * for every remote MCP client (claude.ai connectors, ChatGPT, Claude Code),
 * which probe the root `.well-known` path directly.
 *
 * This is the ONLY thing the `mcp-protocol-surface` pack's composed
 * overlay is allowed to TOUCH for OAuth discovery (never `app.ts` itself).
 */
import { Hono } from "hono";

export const mcpWellKnownRouter = new Hono();

mcpWellKnownRouter.use("*", async (c, next) => {
  if (Deno.env.get("ALCHEMIST_TEMPLATE_KEY") !== "mcp-server") return c.notFound();
  return next();
});

// mcp-protocol-surface pack-owned route registrations (wellKnownRoutes) are
// appended below this line by that pack's composed overlay commit.
