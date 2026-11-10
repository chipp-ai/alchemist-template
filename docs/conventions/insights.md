# Chipp Insights

## Chipp Insights — first-party analytics beacon

A tiny beacon (`https://build.chipp.ai/i/beacon.js`) that Alchemist activates
by committing `chipp-insights.json` to the repo root at generation time,
shaped `{"telemetryPublicKey": "tk_pub_..."}`. Present = active, absent (or
unreadable/malformed) = completely inert — nothing here ever throws or blocks
rendering.

- `src/lib/chipp-insights.ts` reads + validates the file once at module load
  (`CHIPP_INSIGHTS_CONFIG`).
- `src/api/middleware/chipp-insights.ts` injects the beacon `<script>` tag
  right before `</head>` on every HTML response, only when a config was found.
  Mounted in `app.ts` after `compress()`/`secureHeaders()`/`timing()` (same
  ordering rationale as `demo-banner.ts`).
- `web/src/lib/chipp-insights.ts` exports `identifyChippInsightsUser(email)`,
  a no-throw wrapper around `window.chippInsights?.identify(email)`. Called
  from `web/src/stores/auth.svelte.ts` right after every point the store
  learns a user's email (fresh OTP login, session restore on boot).
