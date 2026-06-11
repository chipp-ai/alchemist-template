/**
 * LLM proxy configuration.
 *
 * Customer apps never hold a raw model-provider key. Instead they call
 * the Alchemist platform LLM proxy, which routes the call per-tenant and
 * debits the tenant credit ledger. This config holds the proxy creds and
 * a `configured` gate so features degrade gracefully when they are unset
 * (e.g. local dev) rather than crashing.
 *
 * Injected by the platform into the customer pod env:
 *   - LLM_PROXY_BASE_URL     e.g. https://app.adaas.dev
 *   - WORKER_LLM_PROXY_TOKEN the internal-worker proxy token (x-api-key)
 *   - LLM_PROXY_TENANT_ID     the tenant to bill (X-Internal-Tenant-Id)
 *
 * The embeddings client (src/services/llm/embeddings.ts) is the first
 * consumer; the in-app docs search indexer uses it.
 */

const baseUrl = Deno.env.get("LLM_PROXY_BASE_URL") ?? "";
const proxyToken = Deno.env.get("WORKER_LLM_PROXY_TOKEN") ?? "";
const tenantId = Deno.env.get("LLM_PROXY_TENANT_ID") ?? "";

export interface LlmConfig {
  readonly baseUrl: string;
  readonly proxyToken: string;
  readonly tenantId: string;
  /** Default embeddings model (parity with the platform agent search). */
  readonly embedModel: string;
  /** True only when all three proxy creds are present. */
  readonly configured: boolean;
}

export const LLM_CONFIG: LlmConfig = Object.freeze({
  baseUrl: baseUrl.replace(/\/+$/, ""),
  proxyToken,
  tenantId,
  embedModel: Deno.env.get("LLM_EMBED_MODEL") ?? "text-embedding-3-small",
  configured: !!(baseUrl && proxyToken && tenantId),
});
