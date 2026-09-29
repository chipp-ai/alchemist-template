# Dashboard shell and navigation

The signed-in app renders inside the base shell: `web/src/App.svelte`
(layout and route outlet), `web/src/components/Sidebar.svelte` (navigation,
user block, logout) and hash routes in `web/src/routes.ts`
(svelte-spa-router).

## Adding pages and sidebar links

Do not edit `Sidebar.svelte` or `routes.ts` for a feature page. Both are
base-owned. Use the recipe hook instead:

- `web/src/recipe-routes.ts` exports `recipeRoutes` (path to component) and
  `recipeNavItems` (`{ path, label, icon, testId, visibleTo? }`). It is empty
  in the base.
- `routes.ts` merges `recipeRoutes` after the base routes and before the
  catch-all, so a recipe can add pages and can take over `/`.
- `Sidebar.svelte` renders `recipeNavItems` first. A recipe item with the
  same path as a base item replaces it (a `/` item replaces Dashboard).
- `visibleTo(role)` hides a link from roles that cannot use the page. It is
  display only: the API must enforce access on every request.
- `icon` must be a name `Sidebar.svelte` already draws (grid, activity,
  chart, users, plug, settings, and the rest of its `icons` map).

A pack that fills the hook replaces the whole file, so it must ship a
complete module that still exports both names
(`src/__tests__/recipe-routes-hook.test.ts` pins the hook).

## data-testid

Every interactive element gets `data-testid="{area}-{component}-{element}"`
(for example `settings-form-input-name`). Sidebar links are
`sidebar-nav-<testId>`.
