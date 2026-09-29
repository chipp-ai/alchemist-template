/**
 * Client Tickets Portal feature hook. EMPTY in the base template.
 *
 * The platform's client-tickets-portal pack REPLACES this whole file when a
 * builder turns the portal on, and restores this exact content when they
 * turn it off. A pack must ship a complete module here, never a fragment.
 *
 *   - `routes.ts` merges `clientTicketsPortalRoutes` after the recipe
 *     routes and before the catch-all.
 *   - `Sidebar.svelte` renders `clientTicketsPortalNavItems` after the
 *     recipe links.
 *
 * The server half is src/services/client-tickets-portal/router.ts.
 */

export interface FeatureNavItem {
  /** Route path without the leading "#", for example "/tickets-billing". */
  path: string;
  label: string;
  /** An icon name Sidebar.svelte knows (grid, folder, chart, users, plug, settings, ...). */
  icon: string;
  /** Suffix for the link's data-testid: `sidebar-nav-<testId>`. */
  testId: string;
  /** Display only: the API enforces access on every request. */
  visibleTo?: (role: string) => boolean;
}

// Same widening as routes.ts: svelte-spa-router accepts any component.
// deno-lint-ignore no-explicit-any
export const clientTicketsPortalRoutes: Record<string, any> = {};

export const clientTicketsPortalNavItems: FeatureNavItem[] = [];
