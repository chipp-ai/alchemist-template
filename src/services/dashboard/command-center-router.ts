/**
 * command-center-dashboard-data router stub (headless-monorepo-unification
 * pattern, applied here to fix a live app.ts-wholesale-replacement bug in
 * the `command-center` recipe).
 *
 * Mounted unconditionally at `/api/dashboard/command-center` in `app.ts`
 * for EVERY recipe built from this monorepo. Unlike the headless stubs
 * (`src/services/headless-api/`, `src/services/mcp-protocol/`), this one
 * needs NO runtime env-var gate: it lives at a path unique to the
 * command-center recipe, so an empty router here is completely inert for
 * every other recipe (web-app, cms, commerce, storefront, landing-page,
 * headless api/mcp-server) -- an unmatched request under this prefix 404s
 * exactly as if nothing were mounted at all.
 *
 * This file is the ONLY thing the `command-center-dashboard-data` pack's
 * composed overlay is allowed to TOUCH. Its previous touched path was
 * `src/api/app.ts` directly: since the composition engine's touched-path
 * merge for a non-JSON path REPLACES that path's content wholesale (see
 * that pack's file header in chipp-deno's
 * src/alchemist/services/template-packs/ for the full mechanism), and this
 * pack was the SOLE contributor to that path, every command-center
 * project generated before this fix almost certainly had its real
 * 293-line entrypoint replaced by the pack's two-line route registration
 * -- no auth, no billing, no docs routes, no static SPA serving.
 */
import { Hono } from "hono";

export const commandCenterDashboardRouter = new Hono();

// command-center-dashboard-data pack-owned route registration is appended
// below this line by that pack's composed overlay commit.
