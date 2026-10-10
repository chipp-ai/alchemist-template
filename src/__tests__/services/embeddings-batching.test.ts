/**
 * embedTexts splits a long input list into proxy-sized batches.
 *
 * The platform LLM proxy answers 400 for more than 96 inputs per request.
 * nexa-tutor (2026-10-10) passed a 191-chunk document in one call and failed
 * on every attempt. These tests pin the split and the input order with a
 * mock fetch, no network and no database.
 */

import { assertEquals } from "@std/assert";
import { __setEnvForTest } from "@/lib/env.ts";

// LLM_CONFIG is frozen at module load, so set the proxy env before the import.
__setEnvForTest("LLM_PROXY_BASE_URL", "https://llm-proxy.test");
__setEnvForTest("WORKER_LLM_PROXY_TOKEN", "test-token");
__setEnvForTest("LLM_PROXY_TENANT_ID", "test-tenant");
const { embedTexts, EMBEDDING_MAX_BATCH } = await import("@/services/llm/embeddings.ts");

function withMockProxy(sizes: number[], failOnCall?: number): () => void {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = ((_url: string, init: RequestInit) => {
    calls++;
    const body = JSON.parse(String(init.body)) as { input: string[] };
    sizes.push(body.input.length);
    if (body.input.length > 96 || calls === failOnCall) {
      return Promise.resolve(new Response(JSON.stringify({ error: "rejected" }), { status: 400 }));
    }
    const data = body.input.map((text, index) => ({ index, embedding: [Number(text)] }));
    return Promise.resolve(new Response(JSON.stringify({ model: "m", data }), { status: 200 }));
  }) as typeof fetch;
  return () => {
    globalThis.fetch = original;
  };
}

Deno.test("embedTexts: 191 inputs go out as 96 + 95, in order", async () => {
  const sizes: number[] = [];
  const restore = withMockProxy(sizes);
  try {
    const inputs = Array.from({ length: 191 }, (_, i) => String(i));
    const vecs = await embedTexts(inputs);
    assertEquals(EMBEDDING_MAX_BATCH, 96);
    assertEquals(sizes, [96, 95]);
    assertEquals(vecs?.map((v) => v[0]), inputs.map(Number));
  } finally {
    restore();
  }
});

Deno.test("embedTexts: a failed batch returns null, never a partial list", async () => {
  const sizes: number[] = [];
  const restore = withMockProxy(sizes, 2);
  try {
    const inputs = Array.from({ length: 150 }, (_, i) => String(i));
    assertEquals(await embedTexts(inputs), null);
  } finally {
    restore();
  }
});
