# DEMO_MODE — boot guards, banner + public landing (money + email safety, noindex)

**Status:** implemented — boot-time safety guards, the demo banner, and
the public landing page. `scripts/seed-demo.ts` and the nightly re-seed
loop are a separate slice of the same ticket and may land in other
commits.

## Problem

The template can be deployed as a public, unauthenticated live demo
(`DEMO_MODE=1`). A demo deployment must never (a) move real money, (b)
send real email/SMS to whoever a visitor typed into a form, or (c) get
indexed by search engines and outrank a real customer's deployment. It
must also be a complete no-op when `DEMO_MODE` is unset — zero behavior
change for every normal customer deploy.

## Decision

- **Flag:** `src/config/demo-mode.ts` exports `isDemoMode()`, reading
  `Deno.env.get("DEMO_MODE") === "1"` fresh on every call (not cached at
  module load, unlike `src/config/brand.ts`) so both tests and any
  future runtime toggle see live state without a re-import dance. Same
  pattern as the existing `devRoutesEnabled()` in `src/lib/dev-mode.ts`.
  Rejected: a frozen module-level constant (harder to test, and this
  flag has no reason to be pinned for the pod's lifetime the way brand
  identity does).

- **Stripe boot guard:** `assertNoLiveStripeKeyInDemoMode()` in
  `src/lib/stripe.ts` — the existing single construction point for the
  Stripe SDK. No-ops when DEMO_MODE is off or Stripe isn't configured;
  throws when `STRIPE_SECRET_KEY` is set and does NOT start with
  `sk_test_`. `main.ts` calls this at the very top of boot (before DB
  connection, before anything best-effort) and calls `Deno.exit(1)` on
  failure — this is the one guard in `main.ts` that is intentionally
  NOT fail-open, because the failure mode it prevents is a real credit
  card charge from a public demo. This repo has no client-side
  publishable key usage (Checkout-redirect flow only), so the secret
  key is the only key that needed a guard.

- **Email suppression:** `src/services/email.ts`'s `sendEmail()` is the
  single choke point every transactional email (OTP codes via
  `sendOtpEmail`, invite links via `sendInviteEmail`) already routes
  through. When `isDemoMode()`, `sendEmail()` logs a demo notice and
  returns without touching the SMTP transport — unconditionally, for
  every recipient. Rejected: trying to distinguish "visitor-entered"
  from "seeded demo" addresses — that's a heuristic on user-entered
  data for no safety benefit; suppressing all outbound mail in demo
  mode trivially satisfies "never email a visitor" and is simpler to
  reason about and test.

- **noindex:** `src/api/middleware/demo-noindex.ts` exports two Hono
  middlewares, both no-ops when DEMO_MODE is off:
  - `demoNoindexHeaderMiddleware` — sets `X-Robots-Tag: noindex,
    nofollow` on every response.
  - `demoRobotsTxtRoute` — mounted at `GET /robots.txt`; serves a
    disallow-all body in demo mode, otherwise calls `next()` so the
    request falls through to whatever handled that path before (the
    SPA static fallback), preserving prior behavior exactly.

- **Demo banner:** `src/api/middleware/demo-banner.ts` exports
  `demoBannerMiddleware` (mounted `app.use("*", ...)`) and
  `demoBannerDismissRoute` (mounted `app.get("/demo/dismiss-banner", ...)`).
  Both no-op when DEMO_MODE is off.
  - The middleware runs `await next()` first, then -- only when
    `isDemoMode()` and the dismiss cookie isn't set -- reads the
    downstream response body, and if it's `text/html` and contains a
    `<body ...>` tag, splices a fixed, escaped banner string right after
    it and reassigns `c.res` to a new `Response`. This is genuinely
    server-rendered: the banner text ships in the HTML bytes the server
    sends, so it renders with JavaScript fully disabled.
  - Dismissal is a plain link to `GET /demo/dismiss-banner?to=<path>`,
    which sets a cookie with **no `maxAge`/`expires`** (a true browser
    session cookie -- gone when the browser closes, satisfying
    "session-dismissable") and 302-redirects back to `to`. `to` is
    validated to be a same-origin relative path (must start with `/`,
    must not start with `//`) before use, closing the obvious open-
    redirect hole.
  - Rejected: building the banner client-side from a `/api/*` flag
    fetched by the SPA. That fails "no JS required to display" outright,
    and the SPA is only one of the surfaces that needs the banner (the
    new landing page and any future public page do too) -- a
    response-body-splicing middleware covers all of them uniformly with
    one code path instead of one integration per page.
  - Ordering gotcha: `c.res = new Response(...)` in Hono 4 MERGES the
    prior response's headers into the new one (see
    `Context#set res()` in `hono/dist/context.js`) except `content-type`
    (kept from the new response) and `set-cookie` (explicitly re-applied
    from the old response). This means reassigning `c.res` mid-chain is
    safe: headers set by middleware registered EARLIER than this one
    (e.g. `demoNoindexHeaderMiddleware`'s `X-Robots-Tag`, which runs its
    post-`next()` code AFTER this middleware's, per the onion model) are
    NOT lost. Verified with a composition test
    (`src/__tests__/demo-banner.test.ts`). `demoBannerMiddleware` must
    stay registered AFTER `compress()` in `app.ts` so it rewrites the
    body BEFORE compression happens, not after.

- **Public landing page:** `src/api/routes/demo-landing.ts` exports
  `demoLandingRoute`, mounted `app.get("/", demoLandingRoute)` ahead of
  the static-SPA fallback in `app.ts`. The base template's SPA is
  entirely auth-gated (its only unauthenticated screen is the login
  form), so a demo visitor hitting bare `/` needs something more
  informative than a login box. When DEMO_MODE is off it calls `next()`
  immediately, falling through to the SPA exactly as before this route
  existed.
  - The page is static server-rendered HTML (no template engine, no
    client JS dependency) describing what the template ships, with
    links into the actual README's section anchors on GitHub
    (`#whats-in-the-box`, `#architecture`, etc.) and a CTA into the live
    SPA at `/index.html#/login` -- a DIFFERENT path from the intercepted
    bare `/`, so the SPA's static file is untouched and still reachable.
  - Rejected: rewriting the SPA itself to render a public landing
    route (e.g. a new `/#/welcome` Svelte page). That would require
    frontend routing changes and duplicate content that's supposed to
    describe the template's own README, not the app's own product UI --
    a static server page is simpler, cheaper, and can't drift from the
    banner's HTML-only spirit.
  - The `demoBannerMiddleware` still applies to this page's response
    (it's just another `text/html` response), so the landing page also
    carries the dismissible demo banner -- no special-casing needed.

## Public contract

- Env: `DEMO_MODE=1` turns all of the above on. Any other value (or
  unset) is off. Default off.
- `isDemoMode(): boolean` — `src/config/demo-mode.ts`.
- `assertNoLiveStripeKeyInDemoMode(): void` — `src/lib/stripe.ts`;
  throws `Error` on a live-mode key under DEMO_MODE.
- `sendEmail()` behavior change: returns immediately (no throw) under
  DEMO_MODE, logging `[demo-mode] Email suppressed ...` to the console
  and an info-level structured log line.
- `GET /robots.txt` and the `X-Robots-Tag` response header — both new
  surfaces, both gated on DEMO_MODE.
- `demoBannerMiddleware`, `demoBannerDismissRoute`,
  `DEMO_BANNER_DISMISS_PATH` (`/demo/dismiss-banner`),
  `DEMO_BANNER_DISMISS_COOKIE` (`demo_banner_dismissed`) —
  `src/api/middleware/demo-banner.ts`.
- `demoLandingRoute` — `src/api/routes/demo-landing.ts`; owns the exact
  `GET /` path under DEMO_MODE. The SPA shell remains reachable at
  `GET /index.html` regardless of DEMO_MODE.

## Gotchas

- `assertNoLiveStripeKeyInDemoMode()` only recognizes `sk_test_` as
  "safe" — Stripe's restricted test keys and any other key shape are
  treated as live and will refuse boot. This is deliberate: fail closed
  on anything that isn't unambiguously a test key.
- The Stripe guard runs synchronously before the try/catch DB-connect
  block in `main.ts`, so it can't be accidentally swallowed by that
  block's "continue running, health endpoint reports degraded"
  best-effort pattern.
- `demoRobotsTxtRoute` is registered via `app.get("/robots.txt", ...)`
  ahead of the static-file/SPA-fallback middleware later in `app.ts`.
  It relies on Hono's single merged middleware chain per request (calling
  `next()` from a route handler continues to the next matching
  layer registered after it, same as from `app.use`) to fall through
  cleanly when DEMO_MODE is off.
- The banner middleware only injects into responses whose body it can
  find a `<body ...>` tag in. A response served via `c.body(chunk)`
  streaming or one missing a `<body>` tag (fragment HTML) is left
  untouched rather than risking a corrupt splice -- acceptable because
  every real page this template serves (the SPA shell, the demo landing
  page) is a full document.
  `/robots.txt` (`text/plain`) is naturally excluded by the
  `text/html`-only content-type check.
- `demoLandingRoute` only ever intercepts the EXACT path `/` (`app.get("/", ...)`,
  not a prefix route) -- it does not shadow `/index.html`, `/assets/*`,
  or any other static asset the SPA needs, so the "Open the live demo
  app" CTA keeps working normally.
