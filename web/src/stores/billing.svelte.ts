/**
 * Billing store -- products for sale, the org's purchases, and entitlements.
 *
 * Backed by the built-in monetization layer (src/services/product.service.ts
 * + /api/billing/* routes). To gate a UI surface on a paid product:
 *
 *   import { billingStore } from "../stores/billing.svelte";
 *   {#if billingStore.isEntitled("premium_reports")}
 *     <PremiumReports />
 *   {:else}
 *     <button onclick={() => billingStore.startCheckout(productId)}>Upgrade</button>
 *   {/if}
 *
 * The client map is UX only -- server routes enforce with
 * requireEntitlement("premium_reports").
 */

import { createQuery, invalidateQueries } from "../lib/query.svelte";
import { api } from "../lib/api";

// ── Types (mirror the API payloads) ──

export interface Product {
  id: string;
  productKey: string;
  name: string;
  description: string | null;
  type: "one_time" | "subscription";
  priceCents: number;
  currency: string;
  billingInterval: "month" | "year" | null;
  active: boolean;
  createdAt: string;
}

export interface Purchase {
  id: string;
  productId: string;
  productKey: string;
  productName: string;
  productType: "one_time" | "subscription";
  status: "active" | "past_due" | "canceled" | "refunded";
  amountCents: number;
  currency: string;
  currentPeriodEnd: string | null;
  createdAt: string;
}

export interface NewProductInput {
  productKey: string;
  name: string;
  description?: string;
  type: "one_time" | "subscription";
  priceCents: number;
  currency?: string;
  interval?: "month" | "year";
}

// ── Queries ──

const productsQuery = createQuery({
  key: "billing:products",
  fetcher: () =>
    api.get<{ data: { products: Product[] } }>(
      "/billing/products?includeInactive=true",
    ),
  staleTime: 30_000,
});

const purchasesQuery = createQuery({
  key: "billing:purchases",
  fetcher: () => api.get<{ data: { purchases: Purchase[] } }>("/billing/purchases"),
  staleTime: 30_000,
});

const entitlementsQuery = createQuery({
  key: "billing:entitlements",
  fetcher: () =>
    api.get<{ data: { entitlements: Record<string, boolean> } }>(
      "/billing/entitlements",
    ),
  staleTime: 30_000,
});

// ── Helpers ──

/** "$29.00/mo", "$99.00/yr", "$5.00" */
export function formatPrice(product: Pick<Product, "priceCents" | "currency" | "billingInterval">): string {
  const amount = (product.priceCents / 100).toLocaleString(undefined, {
    style: "currency",
    currency: product.currency.toUpperCase(),
  });
  if (product.billingInterval === "month") return `${amount}/mo`;
  if (product.billingInterval === "year") return `${amount}/yr`;
  return amount;
}

// ── Store facade ──

export const billingStore = {
  get products(): Product[] {
    return productsQuery.data?.data.products ?? [];
  },
  get purchases(): Purchase[] {
    return purchasesQuery.data?.data.purchases ?? [];
  },
  get entitlements(): Record<string, boolean> {
    return entitlementsQuery.data?.data.entitlements ?? {};
  },
  get isLoading(): boolean {
    return productsQuery.isLoading || entitlementsQuery.isLoading;
  },

  isEntitled(productKey: string): boolean {
    return this.entitlements[productKey] === true;
  },

  async createProduct(input: NewProductInput): Promise<void> {
    await api.post("/billing/products", input);
    invalidateQueries("billing:");
  },

  async updateProduct(
    id: string,
    patch: Partial<Pick<Product, "name" | "description" | "active" | "priceCents">>,
  ): Promise<void> {
    await api.patch(`/billing/products/${id}`, patch);
    invalidateQueries("billing:");
  },

  /**
   * Kick off Stripe Checkout for a product. Navigates the browser to
   * Stripe; on success the user lands back on successUrl (default
   * /settings/billing) and the webhook records the purchase.
   */
  async startCheckout(productId: string, opts?: { successUrl?: string; cancelUrl?: string }): Promise<void> {
    const res = await api.post<{ data: { url: string } }>(
      `/billing/products/${productId}/checkout`,
      opts ?? {},
    );
    window.location.href = res.data.url;
  },

  refresh(): void {
    invalidateQueries("billing:");
  },
};
