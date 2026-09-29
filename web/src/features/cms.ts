/**
 * Agency CMS feature hook. EMPTY in the base template.
 *
 * The platform's cms-admin-shell pack REPLACES this whole file when the CMS
 * is turned on (the agency-cms recipe at creation, or an install into an
 * existing project), with the CMS admin pages and a "Sites" sidebar link.
 * A pack must ship a complete module here, never a fragment.
 *
 *   - `routes.ts` merges `cmsRoutes` after the recipe routes and before the
 *     catch-all.
 *   - `Sidebar.svelte` renders `cmsNavItems` after the recipe links.
 *
 * The server half is src/services/cms/router.ts.
 */

// Same widening as routes.ts: svelte-spa-router accepts any component.
// deno-lint-ignore no-explicit-any
export const cmsRoutes: Record<string, any> = {};

/** Same shape as the other feature hooks' nav items (see Sidebar.svelte). */
export const cmsNavItems: Array<{
  path: string;
  label: string;
  icon: string;
  testId: string;
  visibleTo?: (role: string) => boolean;
}> = [];
