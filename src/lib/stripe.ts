/**
 * Shared Stripe client.
 *
 * Single construction point for the Stripe SDK so the API-version pin
 * lives in exactly one place. The platform-injected STRIPE_SECRET_KEY
 * belongs to the customer's connected Stripe account -- never hardcode
 * another key.
 *
 * Usage:
 *   getStripe()      -- returns the client, or null when Stripe is not
 *                       configured (feature-detection call sites).
 *   requireStripe()  -- returns the client or throws BadRequestError
 *                       (route/service call sites where Stripe is needed).
 */

import Stripe from "stripe";
import { BadRequestError } from "@/utils/errors.ts";
import { isDemoMode } from "@/config/demo-mode.ts";

let cached: Stripe | null = null;
let cachedKey: string | null = null;

export function getStripe(): Stripe | null {
  const key = Deno.env.get("STRIPE_SECRET_KEY");
  if (!key) return null;
  if (!cached || cachedKey !== key) {
    cached = new Stripe(key, {
      apiVersion: "2025-02-24.acacia" as Stripe.LatestApiVersion,
    });
    cachedKey = key;
  }
  return cached;
}

export function isStripeConfigured(): boolean {
  return Boolean(Deno.env.get("STRIPE_SECRET_KEY"));
}

export function requireStripe(): Stripe {
  const stripe = getStripe();
  if (!stripe) {
    throw new BadRequestError(
      "Stripe is not configured. Set STRIPE_SECRET_KEY to enable billing.",
    );
  }
  return stripe;
}

/**
 * Boot-time guard for the shared DEMO_MODE contract: a public demo must
 * never be able to move real money. When `DEMO_MODE=1` and Stripe is
 * configured, the secret key MUST be a test-mode key (`sk_test_...`).
 * Throws when a live-mode key (`sk_live_...`, or anything else that
 * isn't recognizably a test key) is detected -- callers are expected to
 * treat this as fatal and refuse to start the server.
 *
 * No-op (returns normally) when DEMO_MODE is off, or when Stripe isn't
 * configured at all -- an unconfigured Stripe can't charge anyone either
 * way, and plenty of demo deployments won't wire up a selling surface.
 */
export function assertNoLiveStripeKeyInDemoMode(): void {
  if (!isDemoMode()) return;

  const key = Deno.env.get("STRIPE_SECRET_KEY");
  if (!key) return;

  if (!key.startsWith("sk_test_")) {
    throw new Error(
      "DEMO_MODE=1 requires a Stripe TEST-mode secret key (sk_test_...). " +
        "STRIPE_SECRET_KEY is set but does not look like a test key -- " +
        "refusing to start to avoid a public demo charging real money. " +
        "Either unset STRIPE_SECRET_KEY or replace it with a sk_test_ key.",
    );
  }
}
