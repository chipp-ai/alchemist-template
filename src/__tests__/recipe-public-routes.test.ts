/**
 * Public recipe pages (no DB, no browser).
 *
 * A project makes an app page public by listing its route key in
 * `recipePublicRoutes` (web/src/recipe-routes.ts). The base `isPublicRoute`
 * in web/src/routes.ts consults that list, so a project never edits the
 * base public sets. Five of eight wave 1 QA apps edited PUBLIC_LITERAL_ROUTES
 * because this hook did not exist.
 */
import { assert, assertEquals, assertFalse } from "@std/assert";
import { matchesAnyRoutePattern, matchesRoutePattern } from "../../web/src/lib/route-pattern.ts";

const WEB_SRC = new URL("../../web/src/", import.meta.url);
const read = (rel: string) => Deno.readTextFile(new URL(rel, WEB_SRC));

Deno.test("route pattern: literal, param, wildcard and root", () => {
  assert(matchesRoutePattern("/pricing", "/pricing"));
  assertFalse(matchesRoutePattern("/pricing", "/pricing/x"));
  assertFalse(matchesRoutePattern("/pricing", "/pricingx"));

  assert(matchesRoutePattern("/share/:id", "/share/abc"));
  assertFalse(matchesRoutePattern("/share/:id", "/share"));
  assertFalse(matchesRoutePattern("/share/:id", "/share/"));
  assertFalse(matchesRoutePattern("/share/:id", "/share/a/b"));

  assert(matchesRoutePattern("/docs/*", "/docs/"));
  assert(matchesRoutePattern("/docs/*", "/docs/a/b"));
  assertFalse(matchesRoutePattern("/docs/*", "/docs"));
  assertFalse(matchesRoutePattern("/docs/*", "/doc/a"));

  assert(matchesRoutePattern("/", "/"));
  assertFalse(matchesRoutePattern("/", "/settings"));

  // The query inside a hash route does not change the page.
  assert(matchesRoutePattern("/search", "/search?q=abc"));
});

Deno.test("route pattern: any of a list; an empty list matches nothing", () => {
  assert(matchesAnyRoutePattern("/share/x", ["/pricing", "/share/:id"]));
  assertFalse(matchesAnyRoutePattern("/settings", ["/pricing", "/share/:id"]));
  assertFalse(matchesAnyRoutePattern("/", []));
});

Deno.test("recipe hook: recipe-routes.ts exports recipePublicRoutes, empty in the base template", async () => {
  const src = await read("recipe-routes.ts");
  assert(
    /export const recipePublicRoutes: string\[\] = \[\];/.test(src),
    "recipe-routes.ts must export an empty recipePublicRoutes in the base template",
  );
});

Deno.test("recipe hook: isPublicRoute consults recipePublicRoutes, with a fallback for older packs", async () => {
  const src = await read("routes.ts");
  assert(/import \* as recipeHook from "\.\/recipe-routes"/.test(src), "namespace import of recipe-routes");
  assert(
    src.includes("(recipeHook as { recipePublicRoutes?: readonly string[] }).recipePublicRoutes ?? []"),
    "a pack without recipePublicRoutes must still build and mean no public pages",
  );
  const fn = src.slice(src.indexOf("export function isPublicRoute"));
  assert(
    fn.slice(0, fn.indexOf("\n}\n")).includes("matchesAnyRoutePattern(path, recipePublicRoutes)"),
    "isPublicRoute must consult recipePublicRoutes",
  );
});

Deno.test("base public sets are unchanged", async () => {
  const src = await read("routes.ts");
  assertEquals(
    src.match(/const PUBLIC_LITERAL_ROUTES = new Set\((.*)\);/)?.[1],
    '["/login", "/signup", "/portal"]',
    "add public pages to recipePublicRoutes in recipe-routes.ts, not here",
  );
  assertEquals(
    src.match(/const PUBLIC_PREFIX_ROUTES = (.*);/)?.[1],
    '["/invite/", "/portal/"]',
    "add public pages to recipePublicRoutes in recipe-routes.ts, not here",
  );
});
