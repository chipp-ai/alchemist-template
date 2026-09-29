---
name: ssr
description: SSR kernel: server-rendered public pages (storefront landing, product pages, sitemap), the storefront route-module discovery, optionalSession, Svelte islands, safe HTML/JSON, design tokens on SSR pages. Load when touching src/services/ssr, src/services/storefront, web/src/islands, optional-session, spa-shell, site.ts or app-links.ts.
paths:
  - "src/services/ssr/**"
  - "src/services/storefront/**"
  - "src/api/middleware/optional-session.ts"
  - "src/lib/spa-shell.ts"
  - "src/config/site.ts"
  - "src/services/app-links.ts"
  - "web/src/islands/**"
---

# SSR kernel

The SPA is hash-routed, so search engines and link previews see nothing
in it. Public pages that must be crawlable (a store's home page, product
pages, a sitemap) are rendered on the server. The kernel is the shared
base for them. It is inert until a route module exists: a project that
never adds one serves exactly what it served before.

## The pieces

| File | What it gives you |
|---|---|
| `src/services/storefront/router.ts` | Mounts every `src/services/storefront/*.routes.ts` at "/" at boot. app.ts mounts it after the API routes and before the SPA fallback. |
| `src/services/storefront/mounts.ts` | `discoverRouteModules`, `mountPublicRoutes` (used by the router and by tests). |
| `src/services/ssr/render-html.ts` | `escapeHtml`, `sanitizeHref`, `renderMarkdownToHtml(md, { allowedPathPrefixes })`. |
| `src/services/ssr/safe-json.ts` | `safeJsonScript` (JSON-LD bodies), `safeJsonAttr` (`data-props`). |
| `src/services/ssr/design-head.ts` | `designHead()`, `designHtmlAttributes()`: the design.json tokens and fonts. |
| `src/services/ssr/islands.ts` | `renderIsland(name, props, fallbackHtml)`, `islandsScriptTag()`. |
| `web/src/islands/entry.ts` | Client runtime. Finds every `web/src/islands/*.svelte` with `import.meta.glob`. |
| `src/api/middleware/optional-session.ts` | `optionalSession`, `getSsrSession`, `SsrSession`, `VISITOR_COOKIE`. |
| `src/lib/spa-shell.ts` | `serveSpaShell`: the built SPA at a prefix such as `/admin`. |
| `src/config/site.ts` | `appPath("/#/x")`: every link into the SPA. |
| `src/services/app-links.ts` | `appOrigin()`: the one `APP_URL` reader for absolute links. |

## Adding a public page

1. Create `src/services/storefront/<name>.routes.ts`. Its default export is
   a Hono router with absolute paths:

   ```ts
   import { Hono } from "hono";
   const router = new Hono();
   router.get("/pricing", (c) => c.html(renderPricingPage()));
   export default router;
   ```

2. That is all. Do not edit `router.ts` or `app.ts`. Discovery is by file
   name, so installing a storefront feature into an existing project only
   adds files.

Rules for route modules:

- Only files ending in `.routes.ts` mount. Put services and helpers next to
  them under any other name.
- Modules share the "/" mount. Paths must not overlap across modules, and
  middleware is path-scoped (`router.use("/products/*", optionalSession)`),
  never `use("*")`.
- A module without a default-exported router stops the app at boot. That
  is on purpose: a missing checkout route must not deploy silently.
- Route modules load by discovery, not by a static import, so
  `deno task check` checks `src/services/storefront/` explicitly. Import
  only packages already in `deno.json`.

## Writing the HTML

- Escape every interpolated string with `escapeHtml`. Build every `href`
  from data with `sanitizeHref`; a null result renders as plain text.
- Markdown goes through `renderMarkdownToHtml` only. Pass
  `allowedPathPrefixes` when only some same-site links are allowed.
- JSON-LD goes through `safeJsonScript`. Never inline `JSON.stringify`.
- Put `designHead()` in `<head>` and `designHtmlAttributes()` on `<html>`.
  Page CSS uses the design tokens only (`var(--color-text)`,
  `var(--space-md)`), never raw colours or sizes.
- Absolute URLs (canonical, sitemap, Stripe return URLs) come from
  `appOrigin()`, never from the request host.
- Links into the SPA use `appPath()`.
- Every interactive element gets a `data-testid`.

## Session and caching

- `optionalSession` never throws. It sets `{ user, visitorId }`; `user` is
  null for anonymous visitors and crawlers. It mints the `visitor_id`
  cookie on the first visit.
- The session personalizes; it does not authorize. Writes and private data
  use `requireAuth`.
- A page that renders anything viewer-specific, or sets a cookie, sends
  `Cache-Control: private, no-store`. Only a page that is the same for
  every visitor and sets no cookie may be `public`.

## Islands

An island is a Svelte 5 component that enhances a server-rendered view
that already works without JS.

1. Create `web/src/islands/<Name>.svelte`. Discovery registers it.
2. On the page: `renderIsland("<Name>", props, fallbackHtml)` where
   `fallbackHtml` is the working no-JS view, and `islandsScriptTag()` once
   before `</body>`.
3. Treat `props` as untrusted in the component: check every field.
4. Never import the SPA (main.ts, App.svelte, stores, routes) from an
   island. `islands-entry-map.test.ts` checks this.

## Moving the SPA off "/"

When a page takes "/", serve the SPA from a prefix with a route module:

```ts
router.get("/admin", serveSpaShell);
router.get("/admin/*", serveSpaShell);
```

and forward old `/#/...` links from the "/" page to `/admin#/...`.
