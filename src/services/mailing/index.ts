/**
 * Mailing lists: the front door for newsletters and any other bulk send.
 *
 * Import from here. The pieces:
 *
 *   contacts.service.ts     who is on the list and how they got there; the
 *                           `email_contacts` import with its attestation
 *   campaign.service.ts     campaigns, the sender check, the warm-up ramp
 *   sender-policy.ts        "never from the shared platform sender"
 *   hygiene.ts              invalid, typo, test/role, reserved addresses
 *   suppression.service.ts  bounces, complaints, one-click unsubscribe
 *   unsubscribe-token.ts    the signed RFC 8058 links and headers
 *
 * Never send a newsletter with a loop over `enqueueEmail`. That loop skips
 * every safeguard here, and it is exactly what put 12,000 imported
 * addresses on the shared sender in one day (2026-11-04).
 */

import { getEnv } from "@/lib/env.ts";
import { type BulkSenderStatus, bulkSenderStatus } from "@/services/mailing/sender-policy.ts";
import {
  WARMUP_BATCH_INTERVAL_MS,
  WARMUP_BATCH_SIZES,
  WARMUP_MAX_COMPLAINT_RATE,
  WARMUP_MAX_HARD_BOUNCE_RATE,
  WARMUP_MIN_SAMPLE,
} from "@/services/mailing/campaign.service.ts";

export * from "@/services/mailing/campaign.service.ts";
export * from "@/services/mailing/contacts.service.ts";
export * from "@/services/mailing/hygiene.ts";
export * from "@/services/mailing/sender-policy.ts";
export * from "@/services/mailing/suppression.service.ts";
export * from "@/services/mailing/unsubscribe-token.ts";

export interface MailingReadiness {
  /** Can a campaign send from this deployment, and if not, what to do. */
  sender: BulkSenderStatus;
  /**
   * True when the provider-feedback endpoint is configured. Without it the
   * warm-up still spaces sends out, but bounces and complaints never reach
   * the app, so its thresholds cannot pause a bad list.
   */
  feedbackConnected: boolean;
  warmup: {
    batchSizes: readonly number[];
    batchIntervalMs: number;
    maxHardBounceRate: number;
    maxComplaintRate: number;
    minSample: number;
  };
}

/** What the campaign screen shows above the Send button. */
export function mailingReadiness(): MailingReadiness {
  let feedbackConnected = false;
  try {
    feedbackConnected = !!getEnv("EMAIL_FEEDBACK_TOKEN");
  } catch {
    feedbackConnected = false;
  }
  return {
    sender: bulkSenderStatus(),
    feedbackConnected,
    warmup: {
      batchSizes: WARMUP_BATCH_SIZES,
      batchIntervalMs: WARMUP_BATCH_INTERVAL_MS,
      maxHardBounceRate: WARMUP_MAX_HARD_BOUNCE_RATE,
      maxComplaintRate: WARMUP_MAX_COMPLAINT_RATE,
      minSample: WARMUP_MIN_SAMPLE,
    },
  };
}
