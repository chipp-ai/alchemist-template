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
