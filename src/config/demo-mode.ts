/**
 * DEMO_MODE — shared contract for Alchemist template live demos.
 *
 * When env `DEMO_MODE=1`, this deployment is a public, unauthenticated
 * showcase of the template rather than a real customer's app. Default is
 * OFF (unset/anything else) — a customer deploy that never sets this var
 * gets zero behavior change anywhere DEMO_MODE is consulted.
 *
 * Read LIVE (not cached at module load, unlike `src/config/brand.ts`) so
 * tests can flip `Deno.env.set("DEMO_MODE", ...)` per-case without a
 * module-reload dance — same pattern as `devRoutesEnabled()` in
 * `src/lib/dev-mode.ts`.
 *
 * Consulted by:
 *  - `main.ts` boot: refuses to start if Stripe is configured with a
 *    live-mode key (`assertNoLiveStripeKeysInDemoMode`).
 *  - `src/services/email.ts`: suppresses outbound mail to visitor-entered
 *    addresses (`isDemoSuppressedEmailRecipient` is NOT here; see that
 *    file for the guard itself — this module only exposes the flag).
 *  - `app.ts`: mounts the noindex header middleware + robots.txt route.
 *  - `scripts/seed-demo.ts` + the nightly re-seed loop (separate ticket
 *    slice).
 */
export function isDemoMode(): boolean {
  return Deno.env.get("DEMO_MODE") === "1";
}
