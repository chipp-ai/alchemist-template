/**
 * Session-duration policy.
 *
 * HIPAA Security Rule §164.312(a)(2)(iii) requires "automatic logoff" — the
 * application terminates an electronic session after a predetermined time
 * of inactivity. The standard interpretation is a 4-hour idle ceiling
 * with a warning shortly before timeout.
 *
 * Activation is binary, gated by the `HIPAA_ENABLED` env var that the
 * Alchemist platform sets on the customer-runtime pod when the project
 * was opted into HIPAA during onboarding (and the BAA is signed). When
 * unset/false, sessions get the default long-lived TTL — there's no
 * org-level toggle inside the template, because the decision is
 * project-scoped (the SAME deployed app is HIPAA-bound or not, not
 * per-org-within-the-app).
 *
 * Customer apps reading this module:
 * - Always call `getSessionDurationMs()` when issuing a JWT — never
 *   hard-code an expiry.
 * - Always read `isHipaaEnabled()` to decide whether to arm SPA-side
 *   activity tracking + the warning modal.
 */

/** 4-hour HIPAA-compliant session timeout. */
export const HIPAA_SESSION_DURATION_MS = 4 * 60 * 60 * 1000;

/** 30-day default session timeout for non-HIPAA deployments. */
export const DEFAULT_SESSION_DURATION_MS = 30 * 24 * 60 * 60 * 1000;

/** True if this customer pod was provisioned with HIPAA mode on. */
export function isHipaaEnabled(): boolean {
  const v = Deno.env.get("HIPAA_ENABLED");
  return v === "true" || v === "1";
}

/** The session TTL this deployment should issue, in ms. */
export function getSessionDurationMs(): number {
  return isHipaaEnabled() ? HIPAA_SESSION_DURATION_MS : DEFAULT_SESSION_DURATION_MS;
}

/** The same TTL expressed as `setExpirationTime` argument for jose. */
export function getSessionDurationJoseExpr(): string {
  // jose accepts a number (seconds) or a duration string. Pass seconds
  // so the caller doesn't have to know the unit.
  return String(Math.floor(getSessionDurationMs() / 1000));
}
