/**
 * headless-api-surface router stub (headless-monorepo-unification).
 *
 * Mounted unconditionally at `/api` in `app.ts` for EVERY recipe built from
 * this monorepo, but self-gated: it 404s on every request unless
 * `ALCHEMIST_TEMPLATE_KEY=api`, so the mount is inert for every other
 * recipe (web-app, cms, commerce, command-center, storefront,
 * landing-page). `ALCHEMIST_TEMPLATE_KEY` is a platform-injected runtime
 * env var (customer-deployment-manifest.ts), not something this repo
 * itself sets.
 *
 * This file is the ONLY thing the `headless-api-surface` pack's composed
 * overlay is allowed to TOUCH (never `app.ts` itself, see that pack's file
 * header in chipp-deno's src/alchemist/services/template-packs/ for why:
 * the composition engine's touched-path merge for a non-JSON path replaces
 * the whole file, which would delete this repo's real entrypoint if it
 * ever targeted app.ts directly). The pack's overlay appends its route
 * registrations below the marker comment; this stub is what makes that
 * append target exist in the first place.
 */
import { Hono } from "hono";

export const headlessApiRouter = new Hono();

headlessApiRouter.use("*", async (c, next) => {
  if (Deno.env.get("ALCHEMIST_TEMPLATE_KEY") !== "api") return c.notFound();
  return next();
});

// headless-api-surface pack-owned route registrations are appended below
// this line by that pack's composed overlay commit.
