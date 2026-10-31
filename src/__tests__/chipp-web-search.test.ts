/**
 * Unit tests for src/lib/chipp-web-search.ts (the Chipp web search client).
 * No network: fetch and env are injected.
 */

import { assert, assertEquals } from "@std/assert";
import { postWebSearch, webSearch, type WebSearchResponse } from "../lib/chipp-web-search.ts";

const ENV: Record<string, string> = {
  CHIPP_INTEGRATION_BROKER_URL: "https://platform.example/",
  CHIPP_INTEGRATION_BROKER_TOKEN: "tok",
  PROJECT_ID: "11111111-1111-4111-8111-111111111111",
  CHIPP_ORG_ID: "22222222-2222-4222-8222-222222222222",
};
const env = (n: string) => ENV[n];

function fakeFetch(status: number, body: unknown, headers: Record<string, string> = {}) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const impl = ((url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return Promise.resolve(
      new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers }),
    );
  }) as typeof fetch;
  return { impl, calls };
}

Deno.test("webSearch: posts to the broker with the project credential and returns results", async () => {
  const ok: WebSearchResponse = {
    ok: true,
    operation: "search",
    mode: "web",
    query: "q",
    results: [{
      title: "T",
      url: "https://a.com",
      snippet: "s",
      date: null,
      lastUpdated: null,
      source: "a.com",
      position: 1,
      publisher: null,
      dateText: null,
    }],
    cost: { vendorMicrodollars: 1000, billedMicrodollars: 1300, billedUsd: 0.0013 },
  };
  const f = fakeFetch(200, ok);
  const res = await webSearch("q", { maxResults: 3, recency: "week" }, { fetchImpl: f.impl, env });
  assertEquals(res, ok);
  assertEquals(f.calls[0].url, "https://platform.example/api/internal/hosted-integration-broker/web-search/search");
  const headers = f.calls[0].init.headers as Record<string, string>;
  assertEquals(headers["X-Alch-Broker-Auth"], "tok");
  assertEquals(headers["x-alch-broker-project"], ENV.PROJECT_ID);
  assertEquals(headers["x-alch-broker-org"], ENV.CHIPP_ORG_ID);
  assertEquals(JSON.parse(String(f.calls[0].init.body)), { maxResults: 3, recency: "week", query: "q" });
});

Deno.test("webSearch: news mode goes to the same search route with mode news", async () => {
  const f = fakeFetch(200, { ok: true, operation: "search", mode: "news", query: "fed", results: [] });
  const res = await webSearch("fed", { mode: "news", maxResults: 5 }, { fetchImpl: f.impl, env });
  assert(res.ok);
  assert(f.calls[0].url.endsWith("/web-search/search"));
  assertEquals(JSON.parse(String(f.calls[0].init.body)), { mode: "news", maxResults: 5, query: "fed" });
});

Deno.test("webSearch: the query argument wins over a query smuggled in options", async () => {
  const f = fakeFetch(200, { ok: true });
  // deno-lint-ignore no-explicit-any
  await webSearch("real", { query: "other" } as any, { fetchImpl: f.impl, env });
  assertEquals(JSON.parse(String(f.calls[0].init.body)).query, "real");
});

Deno.test("webSearch: no credential in env is a non-retryable failure and no request", async () => {
  const f = fakeFetch(200, {});
  const res = await webSearch("q", {}, { fetchImpl: f.impl, env: () => undefined });
  assertEquals(res.ok, false);
  if (!res.ok) assertEquals(res.diagnostic, "production_authentication_unavailable");
  assertEquals(f.calls.length, 0);
});

Deno.test("webSearch: platform error envelope passes through with Retry-After", async () => {
  const f = fakeFetch(
    429,
    { ok: false, diagnostic: "rate_limited", error: "Too many", retryable: true },
    { "retry-after": "12" },
  );
  const res = await webSearch("q", {}, { fetchImpl: f.impl, env });
  assertEquals(res, { ok: false, diagnostic: "rate_limited", error: "Too many", retryable: true, retryAfterSeconds: 12 });
});

Deno.test("webSearch: not-available-yet passes through as a 4xx diagnostic", async () => {
  const f = fakeFetch(400, { ok: false, diagnostic: "web_search_unavailable", error: "Not yet", retryable: false });
  const res = await webSearch("q", {}, { fetchImpl: f.impl, env });
  assertEquals(res.ok, false);
  if (!res.ok) {
    assertEquals(res.diagnostic, "web_search_unavailable");
    assertEquals(res.retryable, false);
  }
});

Deno.test("webSearch: credits exhausted is 402 credits_exhausted", async () => {
  const f = fakeFetch(402, { ok: false, diagnostic: "credits_exhausted", error: "Out", retryable: false });
  const res = await webSearch("q", {}, { fetchImpl: f.impl, env });
  if (res.ok) throw new Error("expected failure");
  assertEquals(res.diagnostic, "credits_exhausted");
});

Deno.test("postWebSearch: unreadable body and network errors never throw", async () => {
  const bad = fakeFetch(502, "<html>");
  const r1 = await postWebSearch<WebSearchResponse>({ query: "q" }, { fetchImpl: bad.impl, env });
  assertEquals(r1.ok, false);
  const thrower = (() => Promise.reject(new TypeError("boom"))) as typeof fetch;
  const r2 = await postWebSearch({ query: "q" }, { fetchImpl: thrower, env });
  assertEquals((r2 as { diagnostic: string }).diagnostic, "upstream_error");
  assertEquals((r2 as { retryable: boolean }).retryable, true);
});
