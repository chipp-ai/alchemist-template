/**
 * Restricted mode at the app's own sign-in.
 *
 * The Chipp platform sends the project's access setting with every member
 * sync (`access` in POST /api/platform/member-sync), and again on every
 * access-setting change, so the stored value is the source of truth. It
 * lives on the one platform_member_sync_state row.
 *
 *   NULL, "open", "sign_in_required"  sign-in works as it always did.
 *   "restricted"                      sign-in admits ONLY:
 *     - platform-synced members (managed_by 'platform', attached to an org)
 *     - app-native users that already exist (managed_by NULL, with an org)
 *     - emails with a pending, unexpired in-app invite
 *     - emails in allowedEmails (the project's Allowed Emails plus every
 *       email with an active grant; the platform computes the list)
 *
 * Everyone else gets ONE message and ONE status (403), whatever the reason,
 * so the refusal tells an outsider they are not admitted and nothing more.
 *
 * Callers: send-otp (before a code is sent), verify-otp, the social-login
 * callback (before an account is created), and MCP OAuth authorize. The
 * platform handoff admits only attached managed members, a subset.
 *
 * FAIL CLOSED: the whole decision is one query. If it fails, sign-in is
 * refused; this is the same moment sign-in would need the database anyway.
 */

import { sql } from "kysely";
import { db } from "@/db/client.ts";
import { log } from "@/lib/logger.ts";
import { ForbiddenError } from "@/utils/errors.ts";

export const ACCESS_MODES = ["open", "sign_in_required", "restricted"] as const;
export type AccessMode = typeof ACCESS_MODES[number];

export const MAX_ALLOWED_EMAILS = 20_000;

export const PRIVATE_APP_MESSAGE = "This app is private. Ask the owner for access.";
const UNAVAILABLE_MESSAGE = "Sign-in is not available right now. Try again in a minute.";

/** Test seam: the decision query. Production never overrides. */
export const _accessDeps = {
  decide: async (email: string): Promise<{ mode: string | null; admitted: boolean }> => {
    const row = await sql<{ mode: string | null; admitted: boolean }>`
      SELECT s.access_mode AS mode,
        (
          s.access_mode IS DISTINCT FROM 'restricted'
          OR ${email} = ANY(s.allowed_emails)
          OR EXISTS (
            SELECT 1 FROM users u
            WHERE lower(u.email) = ${email} AND u.organization_id IS NOT NULL
          )
          OR EXISTS (
            SELECT 1 FROM invites i
            WHERE lower(i.email) = ${email}
              AND i.accepted_at IS NULL AND i.revoked_at IS NULL AND i.expires_at > now()
          )
        ) AS admitted
      FROM (SELECT 1) AS one
      LEFT JOIN platform_member_sync_state s ON s.id = TRUE`.execute(db);
    const r = row.rows[0];
    return { mode: r?.mode ?? null, admitted: r?.admitted !== false };
  },
};

/**
 * Throws ForbiddenError unless `email` may sign in. Passes silently in
 * open and sign_in_required modes and when no setting was ever sent.
 */
export async function assertSignInAdmitted(
  email: string,
  path: "send-otp" | "verify-otp" | "social" | "mcp-oauth",
): Promise<void> {
  const normalized = email.trim().toLowerCase();
  let decision: { mode: string | null; admitted: boolean };
  try {
    decision = await _accessDeps.decide(normalized);
  } catch (err) {
    // We cannot tell whether the app is restricted. Refuse.
    log.error("Access check failed; sign-in refused", {
      source: "auth",
      feature: "restricted-access",
      path,
    }, err as Error);
    throw new ForbiddenError(UNAVAILABLE_MESSAGE);
  }
  if (!decision.admitted) {
    log.info("Sign-in refused: app is restricted", {
      source: "auth",
      feature: "restricted-access",
      path,
    });
    throw new ForbiddenError(PRIVATE_APP_MESSAGE);
  }
}
