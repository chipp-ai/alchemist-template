/**
 * Embeddings client — routes through the Alchemist platform LLM proxy.
 *
 * The customer app never holds a model-provider key. It POSTs to the
 * platform's `/api/llm/embeddings` with the internal-worker headers; the
 * platform calls the provider, returns vectors, and debits the tenant
 * credit ledger. Gated on LLM_CONFIG.configured — callers must handle a
 * `null` return (degrade to keyword search) rather than assuming vectors.
 */

import { LLM_CONFIG } from "@/config/llm.ts";
import { log } from "@/lib/logger.ts";

interface EmbeddingsResponse {
  model: string;
  data: { index: number; embedding: number[] }[];
  usage?: { input_tokens?: number };
}

/**
 * Embed a batch of strings. Returns vectors in input order, or `null` if
 * embeddings are unavailable (proxy unconfigured, or a proxy/transport
 * error). Never throws — search degrades to keyword matching on null.
 */
export async function embedTexts(inputs: string[]): Promise<number[][] | null> {
  if (!LLM_CONFIG.configured) return null;
  if (inputs.length === 0) return [];

  try {
    const res = await fetch(`${LLM_CONFIG.baseUrl}/api/llm/embeddings`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": LLM_CONFIG.proxyToken,
        "X-Internal-Tenant-Id": LLM_CONFIG.tenantId,
      },
      body: JSON.stringify({ model: LLM_CONFIG.embedModel, input: inputs }),
    });
    if (!res.ok) {
      log.warn("embeddings proxy returned non-2xx", {
        source: "llm-embeddings",
        status: res.status,
      });
      return null;
    }
    const json = (await res.json()) as EmbeddingsResponse;
    const ordered = [...json.data].sort((a, b) => a.index - b.index);
    if (ordered.length !== inputs.length) {
      log.warn("embeddings proxy returned wrong count", {
        source: "llm-embeddings",
        want: inputs.length,
        got: ordered.length,
      });
      return null;
    }
    return ordered.map((d) => d.embedding);
  } catch (err) {
    log.warn("embeddings proxy call failed", { source: "llm-embeddings" }, err);
    return null;
  }
}

/** Embed a single string. `null` on failure / unconfigured. */
export async function embedOne(input: string): Promise<number[] | null> {
  const vecs = await embedTexts([input]);
  return vecs ? vecs[0] ?? null : null;
}
