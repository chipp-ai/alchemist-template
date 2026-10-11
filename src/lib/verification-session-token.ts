/**
 * Platform verification-session token (pod side).
 *
 * The Alchemist platform runs post-deploy verification against this app.
 * Most checks need a signed-in page, and the only login is an email code
 * the verifier cannot receive. So the platform signs a short-lived token
 * and trades it at `POST /api/auth/verification-session` for a read-only
 * session on a dedicated verification account.
 *
 * The token is an HS256 JWT signed with ALCH_VERIFICATION_SESSION_SECRET,
 * a per-project secret the platform derives and injects into this pod's
 * environment. It is NOT the session secret (JWT_SECRET): a leaked
 * verification secret can only mint read-only verification sessions.
 *
 * Every claim is checked, fail closed:
 *   - alg HS256 only, typ `alch-verify+jwt` (a session cookie or a WS token
 *     signed with another key can never pass);
 *   - iss / aud pinned to the platform and this endpoint;
 *   - sub must equal this pod's PROJECT_ID (a token for another project
 *     fails even if the secret ever matched, CWE-639);
 *   - exp required, and the token must be at most MAX_TOKEN_AGE_SECONDS old
 *     (a long-lived token cannot be minted even with the secret);
 *   - jti required (replay is blocked by the caller's one-time jti claim);
 *   - ro must be literally `true` (only read-only sessions exist).
 *
 * No DB or network imports, so this module unit-tests without a database.
 */

import * as jose from "jose";

export const VERIFICATION_TOKEN_ISSUER = "chipp-alchemist";
export const VERIFICATION_TOKEN_AUDIENCE = "alchemist-verification-session";
export const VERIFICATION_TOKEN_TYP = "alch-verify+jwt";
/** A platform token is single-use and lives minutes, never longer. */
export const MAX_TOKEN_AGE_SECONDS = 600;
/** Tolerated clock skew between the platform host and this pod. */
export const CLOCK_TOLERANCE_SECONDS = 30;
/** Session lifetime bounds (seconds). The platform asks; the pod clamps. */
export const MIN_SESSION_TTL_SECONDS = 300;
export const DEFAULT_SESSION_TTL_SECONDS = 900;
export const MAX_SESSION_TTL_SECONDS = 1800;

const JTI_RE = /^[A-Za-z0-9_-]{16,128}$/;
const ROLE_RE = /^[a-z][a-z0-9_-]{0,31}$/;
/** Ticket / run ids are audit labels. Bound their shape so a log line stays sane. */
const LABEL_RE = /^[A-Za-z0-9_.:-]{1,128}$/;

export interface VerificationTokenClaims {
  projectId: string;
  role: string;
  jti: string;
  ticketId: string;
  runId: string;
  sessionTtlSeconds: number;
}

export type VerificationTokenResult =
  | { ok: true; claims: VerificationTokenClaims }
  | { ok: false; reason: "malformed" | "invalid" | "expired" | "wrong_project" | "not_read_only" };

export function clampSessionTtlSeconds(requested: unknown): number {
  const n = typeof requested === "number" && Number.isFinite(requested)
    ? Math.round(requested)
    : DEFAULT_SESSION_TTL_SECONDS;
  return Math.min(MAX_SESSION_TTL_SECONDS, Math.max(MIN_SESSION_TTL_SECONDS, n));
}

/**
 * Verify a platform verification token. Never throws: every failure maps to
 * a coarse reason code that is safe to return to the caller (no secret, no
 * claim echo).
 */
export async function verifyVerificationToken(
  token: string,
  secret: string,
  expectedProjectId: string,
): Promise<VerificationTokenResult> {
  if (!token || token.length > 4096 || token.split(".").length !== 3) {
    return { ok: false, reason: "malformed" };
  }
  let payload: jose.JWTPayload;
  try {
    const verified = await jose.jwtVerify(token, new TextEncoder().encode(secret), {
      algorithms: ["HS256"],
      issuer: VERIFICATION_TOKEN_ISSUER,
      audience: VERIFICATION_TOKEN_AUDIENCE,
      typ: VERIFICATION_TOKEN_TYP,
      requiredClaims: ["exp", "iat", "jti", "sub"],
      maxTokenAge: MAX_TOKEN_AGE_SECONDS,
      clockTolerance: CLOCK_TOLERANCE_SECONDS,
    });
    payload = verified.payload;
  } catch (err) {
    if (err instanceof jose.errors.JWTExpired) return { ok: false, reason: "expired" };
    return { ok: false, reason: "invalid" };
  }

  // A token whose exp sits far past iat would let a leaked token live longer
  // than intended. jose already enforces maxTokenAge from iat; this pins exp
  // to the same window.
  if (
    typeof payload.iat !== "number" || typeof payload.exp !== "number" ||
    payload.exp - payload.iat > MAX_TOKEN_AGE_SECONDS
  ) {
    return { ok: false, reason: "invalid" };
  }
  if (payload.sub !== expectedProjectId) return { ok: false, reason: "wrong_project" };
  if (payload.ro !== true) return { ok: false, reason: "not_read_only" };

  const role = payload.role;
  const jti = payload.jti;
  const ticketId = payload.ticket;
  const runId = payload.run;
  if (
    typeof role !== "string" || !ROLE_RE.test(role) ||
    typeof jti !== "string" || !JTI_RE.test(jti) ||
    typeof ticketId !== "string" || !LABEL_RE.test(ticketId) ||
    typeof runId !== "string" || !LABEL_RE.test(runId)
  ) {
    return { ok: false, reason: "malformed" };
  }

  return {
    ok: true,
    claims: {
      projectId: payload.sub,
      role,
      jti,
      ticketId,
      runId,
      sessionTtlSeconds: clampSessionTtlSeconds(payload.ttl),
    },
  };
}
