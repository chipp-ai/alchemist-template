/**
 * Chipp Insights -- client-side `identify()` call.
 *
 * The beacon script (https://build.chipp.ai/i/beacon.js) is injected
 * server-side into `<head>` by `src/api/middleware/chipp-insights.ts`,
 * ONLY when `chipp-insights.json` exists at the repo root with a minted
 * `telemetryPublicKey`. When that file is absent (most template checkouts
 * before Alchemist mints a key), the script never loads and
 * `window.chippInsights` is `undefined` -- calling this helper is then a
 * complete no-op. Never throws, so it can never break the auth flow it's
 * instrumenting.
 *
 * Called from `web/src/stores/auth.svelte.ts` right after every point
 * where the store learns a user's email (fresh OTP login, session
 * restore on boot).
 */

declare global {
  interface Window {
    chippInsights?: {
      identify: (email: string) => void;
    };
  }
}

export function identifyChippInsightsUser(email: string): void {
  if (typeof window === "undefined") return;
  try {
    window.chippInsights?.identify(email);
  } catch {
    // The beacon must never be able to break the app it instruments.
  }
}
