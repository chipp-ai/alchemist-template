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
  const out: number[][] = [];
  for (let i = 0; i < inputs.length; i += EMBEDDING_MAX_BATCH) {
    const vectors = await embedSingleBatch(inputs.slice(i, i + EMBEDDING_MAX_BATCH));
    if (!vectors) return null;
    out.push(...vectors);
  }
  return out;
}

/**
 * The platform proxy answers 400 "input exceeds max batch size of 96" for a
 * larger request (see chipp-deno docs/llm-proxy-embeddings.md), so
 * `embedTexts` splits any input list into batches of at most this size.
 * Without the split, a caller that passed a whole document's chunks in one
 * call failed on every attempt (nexa-tutor, 2026-10-10: 191 chunks).
 */
export const EMBEDDING_MAX_BATCH = 96;

/** One proxy call. Callers keep `inputs` at or under EMBEDDING_MAX_BATCH. */
async function embedSingleBatch(inputs: string[]): Promise<number[][] | null> {

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
