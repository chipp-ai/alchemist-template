# HIPAA mode

## HIPAA mode — env-var-gated, no schema changes

The template ships every building block for HIPAA-compliant session handling. Activation is binary, sourced from a single env var the Alchemist platform sets on the customer pod when the project was opted into HIPAA during onboarding (and the BAA was signed):

```
HIPAA_ENABLED=true
```

When set:
- Session JWTs expire after **4 hours** instead of 30 days (`src/utils/session-duration.ts`).
- The session cookie's `Max-Age` matches the JWT's `exp`.
- `/auth/me` returns `hipaaEnabled: true` and `sessionDurationMs: 14400000`.
- The SPA arms `sessionTimeoutStore` (`web/src/stores/sessionTimeout.svelte.ts`): activity tracking on `mousedown / keydown / scroll / touchstart / click` (throttled 1/sec), server-touch via `POST /auth/touch` (throttled 1/5 min), warning modal at TTL−5min, force-logout at TTL.
- Multiple tabs sync via `BroadcastChannel("alchemist-session-activity")` so activity in one tab resets timers in others.

When unset/false:
- 30-day default sessions, no activity tracking, no warning modal. The `sessionTimeoutStore` stays inert (`active: false`).

There is **no per-user / per-org HIPAA toggle inside this template**. The whole deployed app is HIPAA-bound or it isn't — that's a project-scope decision the alchemist platform records and propagates via the env var. Don't add a `hipaa_enabled` column on `organizations`; the platform's onboarding flow + customer-pod env is the only source of truth.

The `POST /auth/touch` endpoint re-issues a JWT with a fresh `exp` claim and resets the cookie. It calls `requireAuth`, so a session that already lapsed gets 401 → SPA force-logout. The store throttles outgoing `/touch` calls to once per 5 minutes regardless of how active the user is.
