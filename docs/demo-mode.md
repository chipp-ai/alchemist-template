# DEMO_MODE — boot guards (money + email safety, noindex)

**Status:** implemented (this slice: boot-time safety guards only — the
demo banner, `scripts/seed-demo.ts`, and the nightly re-seed loop are
separate slices of the same ticket and may land in other commits).

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
