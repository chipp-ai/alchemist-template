/**
 * The public storefront router: server-rendered pages a recipe adds at the
 * site root. Part of the SSR kernel (`.claude/rules/ssr.md`).
 *
 * app.ts mounts this router at "/" after the API routes and before the SPA
 * fallback. At boot it mounts every `src/services/storefront/*.routes.ts`
 * (see `./mounts.ts`). The base template ships no route module, so for a
 * project that never adds a storefront this router is empty and inert:
 * every request falls through to the routes after it.
 *
 * Packs never edit this file or app.ts. They add a `<name>.routes.ts` file.
 */

import { Hono } from "hono";
import { log } from "@/lib/logger.ts";
import { discoverRouteModules, mountPublicRoutes } from "./mounts.ts";

const STOREFRONT_DIR = new URL("./", import.meta.url);

export const storefrontRouter = new Hono();

const mounted = await mountPublicRoutes(
  storefrontRouter,
  await discoverRouteModules(STOREFRONT_DIR),
  (spec) => import(new URL(spec, STOREFRONT_DIR).href),
);

if (mounted.length > 0) {
  log.info("Storefront route modules mounted", { source: "ssr", feature: "storefront-router", mounted });
}
