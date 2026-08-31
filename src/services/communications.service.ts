/**
 * Communications gate -- the single suppression check for outbound email.
 *
 * Two independent switches, both of which must be ON for ordinary mail to
 * go out:
 *
 *   ORG MASTER     `organizations.communications_enabled` (default true).
 *                  An admin turns it off to silence the whole workspace,
 *                  e.g. while a data import back-fills a year of records.
 *   PER USER       `users.preferences.communicationsEnabled` (default
 *                  true, absent = true). Read from the preferences JSONB
 *                  that already exists (db/migrations/005_user_preferences.sql)
 *                  and is already writable via PATCH /api/auth/me/preferences.
 *                  No new per-user table, no new route.
 *
 * Two things are DELIBERATELY outside the gate, and this ordering is the
 * whole point of the module:
 *
 *   1. AUTH-CRITICAL mail (the OTP code, an invite acceptance link, a
 *      portal access link). Suppressing those does not quiet a mailbox,
 *      it locks a person out of their account. `sendEmail` never calls
 *      this function for an auth-critical kind.
 *   2. THE TEST SEND. `sendTestEmail()` exists so an admin can prove
 *      delivery works; running it through the gate makes the diagnostic
 *      fail exactly when the thing being diagnosed is on. It passes
 *      `bypassSuppression`.
 *
 * Fails OPEN. If the lookup throws (DB down, pool exhausted) the mail
 * goes out and we log an error. A gate that fails closed silently drops
 * customer mail during an unrelated outage, which is a worse failure than
 * one extra notification.
 */

import { db } from "@/db/client.ts";
import { log } from "@/lib/logger.ts";

const LOG_SOURCE = "communications";

/** The users.preferences key holding the per-user master switch. */
export const USER_COMMUNICATIONS_PREF_KEY = "communicationsEnabled";

export type SuppressionReason = "org_disabled" | "user_opted_out";

export interface SuppressionResult {
  suppressed: boolean;
  reason?: SuppressionReason;
}

const ALLOWED: SuppressionResult = { suppressed: false };

/**
 * Should this ordinary (non-auth-critical) message be suppressed?
 *
 * @param opts.to             recipient address; used to find the user row
 *                            whose preference applies
 * @param opts.organizationId org whose master toggle applies. When
 *                            omitted, falls back to the recipient's own
 *                            org, so a caller that only knows an address
 *                            still gets the org gate.
 */
export async function checkCommunicationsSuppression(opts: {
  to: string;
  organizationId?: string | null;
}): Promise<SuppressionResult> {
  const email = opts.to.trim().toLowerCase();

  try {
    const recipient = await db
      .selectFrom("users")
      .select(["id", "organizationId", "preferences"])
      .where("email", "=", email)
      .executeTakeFirst();

    if (recipient && !userWantsCommunications(recipient.preferences)) {
      return { suppressed: true, reason: "user_opted_out" };
    }

    // The caller's org wins when supplied; otherwise the recipient's own.
    // A recipient with no account and no caller-supplied org has no org
    // gate to apply -- that is a deliberate address, not a member.
    const orgId = opts.organizationId ?? recipient?.organizationId ?? null;
    if (!orgId) return ALLOWED;

    const org = await db
      .selectFrom("organizations")
      .select(["communicationsEnabled"])
      .where("id", "=", orgId)
      .executeTakeFirst();

    if (org && org.communicationsEnabled === false) {
      return { suppressed: true, reason: "org_disabled" };
    }

    return ALLOWED;
  } catch (err) {
    // Fail open, and say so loudly. Silently dropping mail here would be
    // indistinguishable from a working gate.
    log.error(
      "Communications gate lookup failed -- allowing the send",
      { source: LOG_SOURCE, feature: "suppression-check", to: email },
      err as Error,
    );
    return ALLOWED;
  }
}

/**
 * Read the per-user switch out of the preferences JSONB. Absent, null, or
 * anything that is not the literal `false` means "wants mail" -- a user
 * who has never touched the setting is opted IN, and a malformed value
 * never silently mutes someone.
 */
export function userWantsCommunications(preferences: unknown): boolean {
  const prefs = coercePreferences(preferences);
  return prefs[USER_COMMUNICATIONS_PREF_KEY] !== false;
}

/**
 * `users.preferences` is JSONB. Kysely hands it back as an object on the
 * normal path, but a raw-SQL read (or a legacy row written before the
 * jsonb guard) can surface a JSON string. Parse defensively; never throw
 * from a preference read.
 */
function coercePreferences(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object") return value as Record<string, unknown>;
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      if (parsed && typeof parsed === "object") return parsed as Record<string, unknown>;
    } catch {
      // Not JSON. Treat as "no preferences set".
    }
  }
  return {};
}

// ── Org master toggle ──────────────────────────────────────────────────────

/**
 * Read one user's personal switch. Missing user reads as ON, matching the
 * "never silently mute someone" rule above.
 */
export async function getUserCommunicationsEnabled(userId: string): Promise<boolean> {
  const row = await db
    .selectFrom("users")
    .select(["preferences"])
    .where("id", "=", userId)
    .executeTakeFirst();
  return row ? userWantsCommunications(row.preferences) : true;
}

/**
 * Set one user's personal switch. A thin, discoverable alias over the
 * preferences JSONB: it merges a single key into `users.preferences` and
 * is exactly equivalent to `PATCH /api/auth/me/preferences` with
 * `{ communicationsEnabled }`. Merge, never replace, or writing this
 * toggle would silently drop every other preference the app stores.
 *
 * The merged OBJECT goes straight into `.set()`. Pre-serializing a jsonb
 * parameter double-encodes it into a string scalar (see CLAUDE.md).
 */
export async function setUserCommunicationsEnabled(
  userId: string,
  enabled: boolean,
): Promise<boolean> {
  const current = await db
    .selectFrom("users")
    .select(["preferences"])
    .where("id", "=", userId)
    .executeTakeFirst();

  const merged = {
    ...coercePreferences(current?.preferences),
    [USER_COMMUNICATIONS_PREF_KEY]: enabled,
  };

  const row = await db
    .updateTable("users")
    .set({ preferences: merged, updatedAt: new Date() })
    .where("id", "=", userId)
    .returning(["preferences"])
    .executeTakeFirst();

  return row ? userWantsCommunications(row.preferences) : enabled;
}

/** Read the org's master communications toggle. Missing org reads as ON. */
export async function getOrgCommunicationsEnabled(organizationId: string): Promise<boolean> {
  const row = await db
    .selectFrom("organizations")
    .select(["communicationsEnabled"])
    .where("id", "=", organizationId)
    .executeTakeFirst();
  return row?.communicationsEnabled !== false;
}

/** Set the org's master communications toggle. Returns the stored value. */
export async function setOrgCommunicationsEnabled(
  organizationId: string,
  enabled: boolean,
): Promise<boolean> {
  const row = await db
    .updateTable("organizations")
    .set({ communicationsEnabled: enabled, updatedAt: new Date() })
    .where("id", "=", organizationId)
    .returning(["communicationsEnabled"])
    .executeTakeFirst();

  log.info("Org communications toggle updated", {
    source: LOG_SOURCE,
    feature: "org-toggle",
    organizationId,
    enabled,
  });

  return row?.communicationsEnabled !== false;
}
