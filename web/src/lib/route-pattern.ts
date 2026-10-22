/**
 * Match a hash-route path against svelte-spa-router route patterns.
 *
 * Used by `isPublicRoute` (routes.ts) for the public pages a recipe
 * declares in `recipePublicRoutes` (recipe-routes.ts). A pattern is a route
 * key exactly as written in the route table:
 *
 *   "/pricing"        matches "/pricing" only
 *   "/share/:id"      matches "/share/abc", not "/share" or "/share/a/b"
 *   "/docs/*"         matches "/docs/" and anything under it
 *   "/"               matches "/" only
 *
 * The query string in a hash route ("/search?q=x") is ignored.
 *
 * Dependency-free so src/__tests__/recipe-public-routes.test.ts can run it
 * under Deno.
 */

export function matchesRoutePattern(pattern: string, path: string): boolean {
  const want = pattern.split("/");
  const got = path.split("?")[0].split("/");
  const wildcard = want[want.length - 1] === "*";
  if (wildcard) {
    want.pop();
    if (got.length <= want.length) return false;
  } else if (want.length !== got.length) {
    return false;
  }
  return want.every((seg, i) => (seg.startsWith(":") ? got[i].length > 0 : seg === got[i]));
}

/** True when `path` matches any of `patterns`. */
export function matchesAnyRoutePattern(path: string, patterns: readonly string[]): boolean {
  return patterns.some((p) => matchesRoutePattern(p, path));
}
