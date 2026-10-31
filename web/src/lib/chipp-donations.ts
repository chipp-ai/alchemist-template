/**
 * Chipp Payments donations in the browser: the donation catalog, starting a
 * gift, and the thank-you page's confirm and manage calls.
 *
 * No imports on purpose: the DonateForm island (web/src/islands/) may not
 * load the SPA's api client or stores, and a Deno test runs the pure
 * helpers directly. Every call goes to this app's own API
 * (/api/chipp-payments/*); the browser never talks to Stripe or to Chipp.
 */

export type DonationFrequency = "one_time" | "month" | "year";

export interface DonationProduct {
  key: string;
  name: string;
  description: string | null;
  currency: string;
  minAmountCents: number;
  suggestedAmountsCents: number[];
  frequencies: DonationFrequency[];
}

export interface DonationCatalog {
  active: boolean;
  testMode: boolean;
  sandboxAccount: boolean;
  donations: DonationProduct[];
}

export interface DonationReceipt {
  status: string;
  amountCents: number;
  currency: string;
  interval: "month" | "year" | null;
  recurring: boolean;
  canManage: boolean;
}

/** The thank-you page's route. Stripe sends the donor back here. */
export const DONATION_THANK_YOU_RETURN_PATH = "/app/#/donate/thank-you";

export const FREQUENCY_LABELS: Record<DonationFrequency, string> = {
  one_time: "One time",
  month: "Monthly",
  year: "Yearly",
};

/** The largest gift Stripe takes in one charge, in cents. */
export const MAX_DONATION_CENTS = 99_999_999;

/**
 * Pure: a typed amount ("25", "25.50", "$1,000", 25) to whole cents, or
 * null when it is not a usable amount. Accepts a number because Svelte's
 * bind:value on a number input delivers one.
 */
export function parseAmountToCents(input: string | number | null | undefined): number | null {
  if (input === null || input === undefined) return null;
  const s = String(input).trim().replace(/[$,\s]/g, "");
  if (!/^\d+(\.\d{0,2})?$/.test(s)) return null;
  const [whole, frac = ""] = s.split(".");
  const cents = Number(whole) * 100 + Number(frac.padEnd(2, "0"));
  if (!Number.isSafeInteger(cents) || cents <= 0 || cents > MAX_DONATION_CENTS) return null;
  return cents;
}

/** Pure: "$25", "$25.50". Whole amounts drop the cents. */
export function formatDonationAmount(cents: number, currency = "usd"): string {
  const whole = cents % 100 === 0;
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: currency.toUpperCase(),
      minimumFractionDigits: whole ? 0 : 2,
      maximumFractionDigits: 2,
    }).format(cents / 100);
  } catch {
    return `${(cents / 100).toFixed(whole ? 0 : 2)} ${currency.toUpperCase()}`;
  }
}

/** Pure: the reason a gift cannot start, or null. */
export function donationAmountError(cents: number | null, product: Pick<DonationProduct, "minAmountCents" | "currency">): string | null {
  if (cents === null) return "Enter an amount.";
  if (cents < product.minAmountCents) {
    return `The smallest gift is ${formatDonationAmount(product.minAmountCents, product.currency)}.`;
  }
  return null;
}

/** Pure: the gift the return URL names (Chipp adds chipp_purchase and session_id), or null. */
export function readDonationReturn(href: string): { purchaseId: string; sessionId: string } | null {
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return null;
  }
  // The params sit before the hash route; read the hash's own query too.
  const params = new URLSearchParams(url.search);
  const hashQuery = url.hash.includes("?") ? new URLSearchParams(url.hash.slice(url.hash.indexOf("?") + 1)) : null;
  const get = (k: string) => params.get(k) ?? hashQuery?.get(k) ?? null;
  const purchaseId = get("chipp_purchase");
  const sessionId = get("session_id");
  if (!purchaseId || !/^[0-9a-f-]{36}$/i.test(purchaseId)) return null;
  if (!sessionId || !/^cs_[A-Za-z0-9_]{1,250}$/.test(sessionId)) return null;
  return { purchaseId, sessionId };
}

/** Pure: "Thank you for your gift of $25." / "... monthly gift of $25." */
export function thankYouLine(r: Pick<DonationReceipt, "amountCents" | "currency" | "interval">): string {
  const amount = formatDonationAmount(r.amountCents, r.currency);
  if (r.interval === "month") return `Thank you for your monthly gift of ${amount}.`;
  if (r.interval === "year") return `Thank you for your yearly gift of ${amount}.`;
  return `Thank you for your gift of ${amount}.`;
}

type Fetch = typeof fetch;

async function post<T>(path: string, body: unknown, f: Fetch): Promise<T> {
  const res = await f(`/api/chipp-payments${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    credentials: "same-origin",
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({})) as { data?: T; error?: string; message?: string };
  if (!res.ok) throw new Error(data.error ?? data.message ?? "Something went wrong. Try again.");
  return data.data as T;
}

/** The donation products (public). Never throws: a failure reads as "not set up". */
export async function fetchDonationCatalog(f: Fetch = fetch): Promise<DonationCatalog> {
  try {
    const res = await f("/api/chipp-payments/donations", { credentials: "same-origin" });
    if (!res.ok) throw new Error(String(res.status));
    const body = await res.json() as { data: DonationCatalog };
    return body.data;
  } catch {
    return { active: false, testMode: false, sandboxAccount: false, donations: [] };
  }
}

/** Starts Stripe Checkout for a gift and returns its URL. */
export async function startDonation(
  input: {
    productKey: string;
    amountCents: number;
    frequency: DonationFrequency;
    email?: string | null;
    returnPath?: string;
    cancelPath?: string;
  },
  f: Fetch = fetch,
): Promise<string> {
  const data = await post<{ url: string }>("/donate", input, f);
  return data.url;
}

export async function confirmDonation(ref: { purchaseId: string; sessionId: string }, f: Fetch = fetch): Promise<DonationReceipt> {
  return await post<DonationReceipt>("/donation/confirm", ref, f);
}

export async function manageDonationUrl(
  ref: { purchaseId: string; sessionId: string; returnPath?: string },
  f: Fetch = fetch,
): Promise<string> {
  const data = await post<{ url: string }>("/donation/manage", ref, f);
  return data.url;
}
