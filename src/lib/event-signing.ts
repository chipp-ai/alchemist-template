/**
 * One signature scheme for every event that crosses an HTTP boundary:
 * the platform delivering INTO this project's inbox, and this project
 * delivering OUT to a builder's webhook URL.
 *
 *   X-Event-Timestamp: <unix seconds>
 *   X-Event-Signature: v1=<hex HMAC-SHA256(secret, `${timestamp}.${rawBody}`)>
 *
 * The timestamp is part of the signed string, so a captured request
 * cannot be replayed with a fresh timestamp, and the receiver rejects
 * anything older than its tolerance, so it cannot be replayed at all
 * once the window has passed. Same shape as Stripe's, on purpose: every
 * builder has verified one of those before.
 *
 * Comparison is constant time. Length is checked first because
 * `timingSafeEqual` throws on unequal lengths, and a hex digest has a
 * fixed length anyway so the check leaks nothing.
 */

import { createHmac, timingSafeEqual } from "node:crypto";
import { Buffer } from "node:buffer";

export const EVENT_TIMESTAMP_HEADER = "X-Event-Timestamp";
export const EVENT_SIGNATURE_HEADER = "X-Event-Signature";
export const EVENT_ID_HEADER = "X-Event-Id";
export const EVENT_TOPIC_HEADER = "X-Event-Topic";

/** Receivers reject a timestamp further than this from their own clock. */
export const DEFAULT_TIMESTAMP_TOLERANCE_S = 5 * 60;

const SIGNATURE_VERSION = "v1";

export function signEventBody(secret: string, timestampSeconds: number, rawBody: string): string {
  const mac = createHmac("sha256", secret).update(`${timestampSeconds}.${rawBody}`).digest("hex");
  return `${SIGNATURE_VERSION}=${mac}`;
}

export type VerifyFailure =
  | "missing-timestamp"
  | "malformed-timestamp"
  | "stale-timestamp"
  | "missing-signature"
  | "malformed-signature"
  | "signature-mismatch";

export type VerifyResult = { ok: true } | { ok: false; reason: VerifyFailure };

/**
 * Check a received signature. Every failure is a reason slug the caller
 * can log; none of them carries the secret or the presented signature.
 */
export function verifyEventSignature(input: {
  secret: string;
  rawBody: string;
  timestampHeader: string | undefined | null;
  signatureHeader: string | undefined | null;
  nowMs?: number;
  toleranceSeconds?: number;
}): VerifyResult {
  const timestampRaw = (input.timestampHeader ?? "").trim();
  if (timestampRaw.length === 0) return { ok: false, reason: "missing-timestamp" };
  if (!/^\d{1,12}$/.test(timestampRaw)) return { ok: false, reason: "malformed-timestamp" };
  const timestamp = Number(timestampRaw);

  const nowSeconds = Math.floor((input.nowMs ?? Date.now()) / 1_000);
  const tolerance = input.toleranceSeconds ?? DEFAULT_TIMESTAMP_TOLERANCE_S;
  if (Math.abs(nowSeconds - timestamp) > tolerance) return { ok: false, reason: "stale-timestamp" };

  const presented = (input.signatureHeader ?? "").trim();
  if (presented.length === 0) return { ok: false, reason: "missing-signature" };
  if (!/^v1=[0-9a-f]{64}$/.test(presented)) return { ok: false, reason: "malformed-signature" };

  const expected = signEventBody(input.secret, timestamp, input.rawBody);
  const a = Buffer.from(presented, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return { ok: false, reason: "signature-mismatch" };
  }
  return { ok: true };
}
