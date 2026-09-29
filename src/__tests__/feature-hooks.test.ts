/**
 * Feature hooks (source-shape test, no DB, no browser).
 *
 * A builder can turn a feature on after a project exists. The platform then
 * REPLACES a feature's stub files wholesale and restores them when the
 * feature is turned off, so the stubs must stay inert and their readers
 * must keep importing them:
 *
 *   A. web/src/features/client-tickets-portal.ts exports
 *      `clientTicketsPortalRoutes` and `clientTicketsPortalNavItems`.
 *   B. routes.ts spreads the feature routes before the "*" catch-all.
 *   C. Sidebar.svelte renders the feature nav items.
 *   D. app.ts mounts src/services/client-tickets-portal/router.ts at
 *      /api/tickets-and-billing, and the base router is empty.
 */
import { assert, assertEquals } from "@std/assert";
import { app } from "../../app.ts";
import { clientTicketsPortalRouter } from "@/services/client-tickets-portal/router.ts";

const read = (rel: string) => Deno.readTextFile(new URL("../../" + rel, import.meta.url));

Deno.test("feature hook: the client tickets portal SPA stub exports both names", async () => {
  const src = await read("web/src/features/client-tickets-portal.ts");
  assert(/export const clientTicketsPortalRoutes\b/.test(src));
  assert(/export const clientTicketsPortalNavItems\b/.test(src));
});

Deno.test("feature hook: routes.ts spreads the feature routes before the catch-all", async () => {
  const src = await read("web/src/routes.ts");
  assert(
    src.includes('import { clientTicketsPortalRoutes } from "./features/client-tickets-portal";'),
  );
  const spread = src.indexOf("...clientTicketsPortalRoutes,");
  const catchAll = src.indexOf('"*": NotFound');
  assert(spread !== -1 && catchAll !== -1 && spread < catchAll);
});

Deno.test("feature hook: Sidebar.svelte renders the feature nav items", async () => {
  const src = await read("web/src/components/Sidebar.svelte");
  assert(
    src.includes(
      'import { clientTicketsPortalNavItems } from "../features/client-tickets-portal";',
    ),
  );
  assert(src.includes("...clientTicketsPortalNavItems"));
});

Deno.test("feature hook: app.ts mounts the client tickets portal router, which is empty in the base", async () => {
  const src = await read("app.ts");
  assert(src.includes('app.route("/api/tickets-and-billing", clientTicketsPortalRouter);'));
  assertEquals(clientTicketsPortalRouter.routes.length, 0);
  const res = await app.request("/api/tickets-and-billing/summary");
  assertEquals(res.status, 404);
  await res.body?.cancel();
});
