/**
 * Chipp Payments client: sell through Chipp without a Stripe key.
 *
 * When the Chipp platform runs this app with payments on, it injects:
 *
 *   CHIPP_PAYMENTS_URL         the platform origin
 *   CHIPP_PAYMENTS_TOKEN       a derived token bound to this project, org, mode and scope
 *   CHIPP_PAYMENTS_MODE        test | live
 *   CHIPP_PAYMENTS_SCOPE       deploy | preview:<sandboxId>
 *   CHIPP_PAYMENTS_PROJECT_ID  the project the token is bound to
 *   CHIPP_PAYMENTS_ORG_ID      the org the token is bound to
 *
 * Every sale is a direct charge on the org's own Stripe Connect account.
 * This app never holds a Stripe key, an OAuth token or a webhook secret, and
 * never creates a webhook. Chipp settles each sale and tells the app with a
 * signed `entitlement.changed` event at POST /api/events/inbox (see
 * src/services/chipp-entitlements.ts). The app can also pull.
 *
 * The app sends a product KEY, an opaque buyer ref (`org:<orgId>`) and
 * RELATIVE return paths. It never sends a price, an account id or a full
 * URL: Chipp builds the return origin itself. The one amount it sends is a
 * donor's chosen gift (startChippDonation), which Chipp checks against the
 * donation's minimum.
 *
 * Donations: a donation product lets a visitor give any amount at or above
 * a minimum, once or every month or year, with no account in this app.
 * Stripe Checkout collects the donor's email and Stripe emails the receipt.
 *
 * Path choice (never switched silently):
 *   - STRIPE_SECRET_KEY set     -> the app's own Stripe path (product.service.ts), as before.
 *   - otherwise, token present  -> Chipp Payments.
 *   - neither                   -> selling is off; `configured` is false.
 */

import { getEnv } from "@/lib/env.ts";
import { log } from "@/lib/logger.ts";
import { BadRequestError, ExternalServiceError } from "@/utils/errors.ts";

export type ChippPaymentsMode = "test" | "live";

export interface ChippPaymentsConfig {
  url: string;
  token: string;
  mode: ChippPaymentsMode;
  scope: string;
  projectId: string;
  orgId: string;
}

/** The injected config, or null when Chipp Payments is not set up for this app. */
export function chippPaymentsConfig(): ChippPaymentsConfig | null {
  const url = (getEnv("CHIPP_PAYMENTS_URL") ?? "").trim().replace(/\/+$/, "");
  const token = (getEnv("CHIPP_PAYMENTS_TOKEN") ?? "").trim();
  const mode = getEnv("CHIPP_PAYMENTS_MODE");
  const scope = (getEnv("CHIPP_PAYMENTS_SCOPE") ?? "deploy").trim();
  const projectId = (getEnv("CHIPP_PAYMENTS_PROJECT_ID") ?? getEnv("PROJECT_ID") ?? "").trim();
  const orgId = (getEnv("CHIPP_PAYMENTS_ORG_ID") ?? getEnv("CHIPP_ORG_ID") ?? "").trim();
  if (!url || !token || !projectId || !orgId) return null;
  if (mode !== "test" && mode !== "live") return null;
  return { url, token, mode, scope, projectId, orgId };
}

/** True when the app keeps selling with its own Stripe key. */
export function usesOwnStripeKey(): boolean {
  return Boolean(getEnv("STRIPE_SECRET_KEY"));
}

/**
 * True when sales go through Chipp Payments. The app's own key wins: an app
 * that already sells with STRIPE_SECRET_KEY keeps that path until its owner
 * migrates.
 */
export function chippPaymentsActive(): boolean {
  return !usesOwnStripeKey() && chippPaymentsConfig() !== null;
}

/**
 * The mode whose Chipp sales grant access in this app right now: the
 * injected CHIPP_PAYMENTS_MODE, or 'live' when Chipp Payments is not set up
 * (a sale someone paid real money for keeps counting; a test sale never
 * does). A test-card sale can therefore never unlock a live app.
 */
export function chippAccessMode(): ChippPaymentsMode {
  return chippPaymentsConfig()?.mode ?? "live";
}

/** The opaque buyer ref Chipp keys a buyer's sales on. One per organization. */
export function customerRefForOrg(organizationId: string): string {
  return `org:${organizationId}`;
}

/** The organization id inside a buyer ref, or null when it is not one of ours. */
export function orgIdFromCustomerRef(ref: string): string | null {
  const m = /^org:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i.exec(ref);
  return m ? m[1].toLowerCase() : null;
}

/** Pure: a full URL or a path, reduced to a same-origin relative path. */
export function toRelativePath(urlOrPath: string | null | undefined, fallback: string): string {
  const raw = (urlOrPath ?? "").trim();
  if (!raw) return fallback;
  if (raw.startsWith("/") && !raw.startsWith("//") && !raw.startsWith("/\\")) return raw;
  try {
    const u = new URL(raw);
    return `${u.pathname}${u.search}${u.hash}` || fallback;
  } catch {
    return fallback;
  }
}

export interface ChippProduct {
  key: string;
  name: string;
  description: string | null;
  kind: "one_time" | "subscription";
  amountCents: number;
  currency: string;
  interval: "month" | "year" | null;
}

export type DonationFrequency = "one_time" | "month" | "year";

export interface ChippDonationProduct {
  key: string;
  name: string;
  description: string | null;
  kind: "donation";
  currency: string;
  /** The smallest gift, in the currency's minor unit (cents). */
  minAmountCents: number;
  /** The amount chips the form shows. */
  suggestedAmountsCents: number[];
  /** What the donor may choose. */
  frequencies: DonationFrequency[];
}

export interface ChippCatalog {
  mode: ChippPaymentsMode;
  testMode: boolean;
  sandboxAccount: boolean;
  products: ChippProduct[];
  /** Donation products. Older platforms omit it. */
  donations?: ChippDonationProduct[];
}

export interface ChippDonationReceipt {
  purchaseId: string;
  productKey: string;
  status: string;
  amountCents: number;
  currency: string;
  interval: "month" | "year" | null;
  recurring: boolean;
  canManage: boolean;
  donorEmail?: string | null;
  currentPeriodEnd?: string | null;
  seq?: number;
}

export interface ChippEntitlement {
  purchaseId: string;
  /** The mode Chipp sold in (older platforms omit it; the pull is for the caller's mode). */
  mode?: ChippPaymentsMode;
  productKey: string;
  status: string;
  entitled: boolean;
  disputeStatus: string;
  currentPeriodEnd: string | null;
  seq: number;
}

type Fetch = typeof fetch;
let fetchImpl: Fetch = (...args) => fetch(...args);

/** Test seam: replace fetch. No argument restores the global. */
export function __setChippPaymentsFetchForTest(f?: Fetch): void {
  fetchImpl = f ?? ((...args) => fetch(...args));
}

async function call<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
  const cfg = chippPaymentsConfig();
  if (!cfg) throw new BadRequestError("Chipp Payments is not set up for this app.");
  let res: Response;
  try {
    res = await fetchImpl(`${cfg.url}/api/internal/payments-broker${path}`, {
      method,
      headers: {
        "content-type": "application/json",
        "x-chipp-payments-auth": cfg.token,
        "x-chipp-payments-project": cfg.projectId,
        "x-chipp-payments-org": cfg.orgId,
        "x-chipp-payments-mode": cfg.mode,
        "x-chipp-payments-scope": cfg.scope,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
  } catch (err) {
    log.warn("Chipp Payments request failed to reach the platform", {
      source: "chipp-payments",
      path,
    }, err);
    throw new ExternalServiceError(
      "Chipp Payments",
      "Payments are temporarily unavailable. Try again soon.",
    );
  }
  const data = await res.json().catch(() => ({})) as Record<string, unknown>;
  if (res.ok) return data as T;
  const message = typeof data.error === "string"
    ? data.error
    : `Payments request failed (${res.status})`;
  if (res.status === 400 || res.status === 404 || res.status === 409) {
    throw new BadRequestError(message);
  }
  log.error("Chipp Payments request was refused", {
    source: "chipp-payments",
    path,
    status: res.status,
  });
  throw new ExternalServiceError(
    "Chipp Payments",
    res.status === 401 ? "Payments are not set up for this app." : message,
  );
}

export async function listChippProducts(): Promise<ChippCatalog> {
  return await call<ChippCatalog>("GET", "/products");
}

export async function startChippCheckout(input: {
  productKey: string;
  customerRef: string;
  email?: string | null;
  returnPath?: string | null;
  cancelPath?: string | null;
}): Promise<{ url: string; purchaseId: string; testMode: boolean }> {
  return await call("POST", "/checkout", input);
}

export async function startChippPortal(
  input: { customerRef: string; returnPath?: string | null },
): Promise<{ url: string }> {
  return await call("POST", "/portal", input);
}

export async function fetchChippEntitlements(customerRef: string): Promise<ChippEntitlement[]> {
  const res = await call<{ entitlements: ChippEntitlement[] }>(
    "GET",
    `/entitlements?customerRef=${encodeURIComponent(customerRef)}`,
  );
  return res.entitlements ?? [];
}

/** Starts a donation checkout. Anyone may give; no buyer ref is needed. */
export async function startChippDonation(input: {
  productKey: string;
  amountCents: number;
  frequency: DonationFrequency;
  email?: string | null;
  returnPath?: string | null;
  cancelPath?: string | null;
}): Promise<{ url: string; purchaseId: string; testMode: boolean }> {
  return await call("POST", "/donation-checkout", input);
}

/** The gift a thank-you page names (purchase id plus the Checkout Session id from the return URL). */
export async function lookupChippDonation(
  ref: { purchaseId: string; sessionId: string },
): Promise<ChippDonationReceipt> {
  const res = await call<{ donation: ChippDonationReceipt }>("POST", "/donation-lookup", ref);
  return res.donation;
}

/** The billing portal for the donor of a recurring gift (change card, cancel). */
export async function startChippDonationPortal(
  ref: { purchaseId: string; sessionId: string; returnPath?: string | null },
): Promise<{ url: string }> {
  return await call("POST", "/donation-portal", ref);
}
