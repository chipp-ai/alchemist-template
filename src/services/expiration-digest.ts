/**
 * Expiring-records digest -- A SCAFFOLD. Adapt it, do not rebuild it.
 *
 * "Email me before X expires" is the single most-requested scheduled
 * alert: certifications, contracts, licenses, warranties, trial periods.
 * This module is the whole shape of that feature with the domain part
 * left as one registration, so a customer app writes a query and gets the
 * scheduling, the gating, the branded email, and the tests for free.
 *
 * YOUR ONE INTEGRATION POINT is a provider (mirrors the inbound-email
 * extraction profile):
 *
 *   registerExpiringRecordsProvider({
 *     recordLabel: "certifications",
 *     findExpiring: async ({ organizationId, withinDays }) => {
 *       const rows = await db.selectFrom("certifications")
 *         .select(["id", "name", "expiresAt"])
 *         .where("organizationId", "=", organizationId)   // ALWAYS org-scope
 *         .where("expiresAt", "<=", daysFromNow(withinDays))
 *         .where("expiresAt", ">", new Date())
 *         .execute();
 *       return rows.map((r) => ({ id: r.id, label: r.name, expiresAt: r.expiresAt }));
 *     },
 *   });
 *
 * Register it from a module `main.ts` imports. With no provider
 * registered the whole lane is dormant: the job returns
 * `{ skipped: "no-provider" }` every tick and sends nothing.
 *
 * Invariants worth keeping when you adapt this:
 *
 *   - The digest is ORDINARY mail. It goes through the communications
 *     gate, so a muted org or an opted-out user gets nothing. Never mark
 *     a digest auth-critical to "make sure it lands".
 *   - ONE aggregate error log per run, not one per org. A row-scanner
 *     that logs per failure turns a bad afternoon into an alert storm.
 *   - `findExpiring` MUST filter by the organizationId it is handed. The
 *     caller does not re-scope the rows you return.
 */

import { db } from "@/db/client.ts";
import { log } from "@/lib/logger.ts";
import { sendEmailKind } from "@/services/email-kinds.ts";

const LOG_SOURCE = "expiration-digest";

/** Default look-ahead window when the caller does not pass one. */
export const DEFAULT_WITHIN_DAYS = 30;

export interface ExpiringRecord {
  /** Stable id of the record. Used only for de-duplication in your query. */
  id: string;
  /** One-line human label: "Forklift certification -- A. Rivera". */
  label: string;
  expiresAt: Date;
  /** Optional second line of context. */
  detail?: string | null;
  /** Optional deep link into the app for this record. */
  url?: string | null;
}

export interface DigestRecipient {
  email: string;
  userId?: string;
}

export interface ExpiringRecordsProvider {
  /** Plural noun used in the subject and body: "contracts", "licenses". */
  recordLabel: string;
  findExpiring(
    opts: { organizationId: string; withinDays: number },
  ): Promise<ExpiringRecord[]>;
  /**
   * Who receives the digest for an org. Defaults to the org's owner and
   * admins, which is the right audience for an operational alert.
   */
  recipients?(opts: { organizationId: string }): Promise<DigestRecipient[]>;
}

let provider: ExpiringRecordsProvider | null = null;

/** Register the app's provider. Replaces any previous registration. */
export function registerExpiringRecordsProvider(p: ExpiringRecordsProvider): void {
  provider = p;
  log.info("Expiring-records provider registered", {
    source: LOG_SOURCE,
    feature: "register",
    recordLabel: p.recordLabel,
  });
}

/** True when an app has wired a provider. The job stays dormant otherwise. */
export function hasExpiringRecordsProvider(): boolean {
  return provider !== null;
}

/** Test seam: drop the registration so a suite starts from a known state. */
export function clearExpiringRecordsProvider(): void {
  provider = null;
}

export interface DigestRunResult {
  skipped?: "no-provider";
  orgsScanned: number;
  orgsWithExpiring: number;
  recordsFound: number;
  emailsSent: number;
  failures: number;
}

/**
 * Run one digest pass.
 *
 * Callable directly (that is how the tests drive it) and by the scheduled
 * job in src/jobs/expiration-digest.ts. Never throws: a run that fails
 * for one org still covers the rest, and the caller gets counts.
 */
export async function runExpirationDigest(opts: {
  /** Limit the run to one org. Omit to scan every org. */
  organizationId?: string;
  withinDays?: number;
} = {}): Promise<DigestRunResult> {
  const result: DigestRunResult = {
    orgsScanned: 0,
    orgsWithExpiring: 0,
    recordsFound: 0,
    emailsSent: 0,
    failures: 0,
  };

  const active = provider;
  if (!active) return { ...result, skipped: "no-provider" };

  const withinDays = clampWindow(opts.withinDays ?? DEFAULT_WITHIN_DAYS);
  const orgs = await listOrganizations(opts.organizationId);

  // Collected, not logged per-org. One aggregate line at the end.
  const failureSamples: string[] = [];

  for (const org of orgs) {
    result.orgsScanned++;
    try {
      const records = await active.findExpiring({
        organizationId: org.id,
        withinDays,
      });
      if (records.length === 0) continue;

      result.orgsWithExpiring++;
      result.recordsFound += records.length;

      const recipients = active.recipients
        ? await active.recipients({ organizationId: org.id })
        : await defaultRecipients(org.id);

      const sorted = [...records].sort((a, b) => a.expiresAt.getTime() - b.expiresAt.getTime());

      for (const recipient of recipients) {
        // Ordinary mail: the communications gate applies, so a muted org
        // or an opted-out recipient silently receives nothing.
        await sendEmailKind({
          kind: "expiration_digest",
          to: recipient.email,
          organizationId: org.id,
          data: {
            organizationName: org.name,
            recordLabel: active.recordLabel,
            withinDays,
            records: sorted,
          },
        });
        result.emailsSent++;
      }
    } catch (err) {
      result.failures++;
      if (failureSamples.length < 5) {
        failureSamples.push(`${org.id}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  if (result.failures > 0) {
    // ONE aggregate error for the whole run. The message string is static
    // so it groups cleanly; the counts and samples ride in the context.
    log.error("Expiration digest run had failures", {
      source: LOG_SOURCE,
      feature: "run",
      failures: result.failures,
      orgsScanned: result.orgsScanned,
      samples: failureSamples,
    });
  }

  log.info("Expiration digest run complete", {
    source: LOG_SOURCE,
    feature: "run",
    ...result,
  });

  return result;
}

// ── Internals ──────────────────────────────────────────────────────────────

/** Look-ahead window, clamped to something a human would actually pick. */
function clampWindow(days: number): number {
  if (!Number.isFinite(days)) return DEFAULT_WITHIN_DAYS;
  return Math.min(365, Math.max(1, Math.floor(days)));
}

async function listOrganizations(
  organizationId?: string,
): Promise<Array<{ id: string; name: string }>> {
  let query = db.selectFrom("organizations").select(["id", "name"]);
  if (organizationId) query = query.where("id", "=", organizationId);
  return await query.execute();
}

/**
 * Default audience: the org's owner and admins. Editors and viewers are
 * excluded -- an expiry alert is an operational obligation, not news.
 */
async function defaultRecipients(organizationId: string): Promise<DigestRecipient[]> {
  const rows = await db
    .selectFrom("users")
    .select(["id", "email"])
    .where("organizationId", "=", organizationId)
    .where("role", "in", ["owner", "admin"])
    .execute();
  return rows.map((r) => ({ email: r.email, userId: r.id }));
}
