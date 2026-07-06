/**
 * Inbound-email extraction-profile seam.
 *
 * The generic pipeline (webhook -> capture -> background extraction) is
 * domain-agnostic; what to EXTRACT and what to DO with the extracted data
 * is customer-specific. A customer project plugs its domain in by
 * registering ONE extraction profile at boot (e.g. from main.ts):
 *
 *   registerInboundEmailExtractionProfile({
 *     dataKind: "shipment_data",
 *     dataSchema: z.object({ ... }),
 *     extractionInstructions: "A shipment email reports container ...",
 *     applyData: async ({ orgId, emailId, data }) => { ... },
 *   });
 *
 * With NO profile registered the pipeline is DORMANT: the webhook still
 * captures durably (rows pile up at status='received'), and the reaper's
 * batch drain no-ops -- nothing is lost, extraction simply starts once a
 * profile ships.
 *
 * # applyData contract (BINDING)
 *
 *   - MUST be IDEMPOTENT keyed on `emailId`. The reaper re-runs `failed`
 *     rows, and a multi-pod race can process the same email twice --
 *     re-applying the SAME email must collapse to the same downstream
 *     rows, never duplicates. Recommended dedup-key convention for
 *     downstream writes: `email:<emailId>|<domain-specific-suffix>`
 *     with ON CONFLICT DO NOTHING.
 *   - `orgId` may be null (INGEST_ORG_ID unset); the profile decides
 *     whether to defer, apply globally, or count the item as failed.
 *   - A thrown error marks the email `failed` (with the message as the
 *     status reason) and the reaper re-picks it later; a RETURNED result
 *     marks it `extracted` with the result persisted to apply_result.
 *   - Partial failure should be REPORTED via the counts, not thrown,
 *     unless the whole email should be retried.
 */

import type { z } from "zod";

/** Outcome of applying extracted domain data. Persisted to inbound_email.apply_result. */
export interface InboundEmailApplyResult {
  /** Items applied to the domain store. */
  applied: number;
  /** Items deferred for human review (low confidence, missing org, ...). */
  deferred?: number;
  /** Items that could not be applied. */
  failed?: number;
  /** One-line human summary (becomes the row's status_reason). */
  summary?: string;
}

export interface InboundEmailExtractionProfile<S extends z.ZodTypeAny = z.ZodTypeAny> {
  /**
   * Discriminator for the domain-data triage variant (e.g. "shipment_data",
   * "invoice_data"). Must NOT be "human_message" or "unclear" (reserved).
   */
  dataKind: string;
  /** Zod OBJECT schema for the domain data payload. */
  dataSchema: S;
  /** Domain guidance appended to the base triage system prompt. */
  extractionInstructions: string;
  /** Apply extracted data to the domain. See the idempotency contract above. */
  applyData(
    input: { orgId: string | null; emailId: string; data: z.infer<S> },
  ): Promise<InboundEmailApplyResult>;
}

// Module-scoped singleton. Deliberately ONE profile per app: the triage
// prompt classifies into exactly one domain-data kind; a project needing
// multiple document families models them INSIDE its dataSchema.
let registered: InboundEmailExtractionProfile | null = null;

const RESERVED_KINDS = new Set(["human_message", "unclear"]);

/**
 * Register the app's extraction profile. Idempotent for the SAME dataKind
 * (a hot-reload double-registration is a no-op); throws when a profile
 * with a DIFFERENT dataKind is already registered -- two competing domain
 * profiles is a wiring bug, not a runtime condition to tolerate.
 */
export function registerInboundEmailExtractionProfile(
  profile: InboundEmailExtractionProfile,
): void {
  if (!profile.dataKind || RESERVED_KINDS.has(profile.dataKind)) {
    throw new Error(
      `inbound-email profile dataKind ${JSON.stringify(profile.dataKind)} is empty or reserved`,
    );
  }
  if (registered && registered.dataKind !== profile.dataKind) {
    throw new Error(
      `inbound-email extraction profile already registered with dataKind ` +
        `'${registered.dataKind}'; refusing to replace it with '${profile.dataKind}'`,
    );
  }
  registered = profile;
}

/** The registered profile, or null when the pipeline is dormant. */
export function getInboundEmailExtractionProfile(): InboundEmailExtractionProfile | null {
  return registered;
}

/** Test hook -- clear the singleton. Production code never calls this. */
export function clearInboundEmailExtractionProfileForTest(): void {
  registered = null;
}
