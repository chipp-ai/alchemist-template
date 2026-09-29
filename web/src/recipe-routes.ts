/**
 * Recipe SPA routes and sidebar links. EMPTY in the base template.
 *
 * A recipe pack (for example `command-center-shell-ui`) REPLACES this whole
 * file with a complete module that exports the same names. The platform's
 * composition engine writes a pack's version over the file wholesale, so
 * a pack must ship a complete module here, never a fragment.
 *
 *   - `routes.ts` merges `recipeRoutes` over the base routes, so a recipe
 *     can add pages and can take over "/" (its home page).
 *   - `Sidebar.svelte` renders `recipeNavItems` first. A recipe item whose
 *     path is "/" replaces the base Dashboard link.
 *
 * Add a recipe page here, not in routes.ts: routes.ts stays base-owned.
 */

export interface RecipeNavItem {
  /** Route path without the leading "#", for example "/reports". */
  path: string;
  label: string;
  /** An icon name Sidebar.svelte knows (grid, activity, chart, users, plug, settings, ...). */
  icon: string;
  /** Suffix for the link's data-testid: `sidebar-nav-<testId>`. */
  testId: string;
  /**
   * Hide the link from roles that cannot use the page. Display only: the
   * API enforces access on every request.
   */
  visibleTo?: (role: string) => boolean;
}

// Same widening as routes.ts: Svelte 5 component types do not unify
// under one brand, and svelte-spa-router accepts any component.
// deno-lint-ignore no-explicit-any
export const recipeRoutes: Record<string, any> = {};

export const recipeNavItems: RecipeNavItem[] = [];
