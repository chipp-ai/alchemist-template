/**
 * Recipe SPA hook (source-shape test, no DB, no browser).
 *
 * Recipe packs replace web/src/recipe-routes.ts WHOLESALE to add pages and
 * sidebar links. The platform composes that file without ever reading the
 * base copy, so the contract between the file and its two readers must not
 * drift:
 *
 *   A. recipe-routes.ts exports `recipeRoutes` and `recipeNavItems`.
 *   B. routes.ts spreads `recipeRoutes` AFTER the base routes (so a recipe
 *      can take over "/") and BEFORE the "*" catch-all.
 *   C. Sidebar.svelte imports `recipeNavItems` and renders them.
 */
import { assert } from "@std/assert";

const WEB_SRC = new URL("../../web/src/", import.meta.url);
const read = (rel: string) => Deno.readTextFile(new URL(rel, WEB_SRC));

Deno.test("recipe hook: recipe-routes.ts exports recipeRoutes and recipeNavItems", async () => {
  const src = await read("recipe-routes.ts");
  assert(
    /export const recipeRoutes\b/.test(src),
    "recipe-routes.ts must export recipeRoutes",
  );
  assert(
    /export const recipeNavItems\b/.test(src),
    "recipe-routes.ts must export recipeNavItems",
  );
});

Deno.test("recipe hook: routes.ts spreads recipeRoutes after the base routes and before the catch-all", async () => {
  const src = await read("routes.ts");
  assert(
    /import \{ recipeRoutes \} from "\.\/recipe-routes"/.test(src),
    "routes.ts must import recipeRoutes",
  );
  const spread = src.indexOf("...recipeRoutes,");
  const home = src.indexOf('"/": Dashboard');
  const catchAll = src.indexOf('"*": NotFound');
  assert(
    spread !== -1,
    "routes.ts must spread recipeRoutes into the route table",
  );
  assert(
    home !== -1 && home < spread,
    "recipeRoutes must come after the base routes",
  );
  assert(
    catchAll !== -1 && spread < catchAll,
    "recipeRoutes must come before the catch-all",
  );
});

Deno.test("recipe hook: Sidebar.svelte renders recipeNavItems", async () => {
  const src = await read("components/Sidebar.svelte");
  assert(
    /import \{ recipeNavItems \} from "\.\.\/recipe-routes"/.test(src),
    "Sidebar must import recipeNavItems",
  );
  assert(src.includes("recipeNavItems"), "Sidebar must render recipeNavItems");
});
