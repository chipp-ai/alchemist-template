/**
 * Support page feature hook. EMPTY in the base template.
 *
 * The platform's app-support pack REPLACES this whole file when a builder
 * turns on "Support page for app users", and restores this exact content
 * when they turn it off. A pack must ship a complete module here, never a
 * fragment.
 *
 *   - `routes.ts` merges `supportRoutes` before the catch-all.
 *   - `routes.ts` treats every path in `supportPublicPaths` as public and
 *     as an end-user portal route, so `/support` renders in PortalLayout
 *     and a signed-out visitor is not sent to the admin sign-in form.
 *   - `Sidebar.svelte` renders `supportNavItems`, and `PortalLayout.svelte`
 *     shows a Support link when the list is not empty.
 *
 * The server half is src/services/support/router.ts. The agent tools are
 * src/services/support/agent-tools.ts.
 */

export interface SupportNavItem {
  /** Route path without the leading "#", for example "/support". */
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
export const supportRoutes: Record<string, any> = {};

export const supportNavItems: SupportNavItem[] = [];

/** Literal paths that render in the end-user portal shell without a session. */
export const supportPublicPaths: string[] = [];
