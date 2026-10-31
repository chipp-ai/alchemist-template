/**
 * Chipp web search client.
 *
 * Live Google web and news results for this app's SERVER code: news
 * tracking, research, market intel, monitoring, fact-checking. The Chipp
 * platform holds the search account and key; this app holds only the broker
 * credential the platform injects at deploy time (the same env
 * `src/lib/chipp-integrations.ts` reads). There is nothing to connect and no
 * API key to ask for.
 *
 *   webSearch(query, options)                   ranked web results
 *   webSearch(query, { mode: "news", ... })     recent news articles
 *
 * Each result: title, url, snippet, date (YYYY-MM-DD or null), source
 * (domain), position, publisher (news outlet name in news mode, else null),
 * dateText (the date as Google showed it).
 *
 * Every search is billed to the workspace's Chipp credits (about $0.0013 per
 * search). Cache what many people see, and show the source link with every
 * result. To write an answer from the results, pass them to the LLM proxy.
 *
 * Server only: never import this from `web/`. Calls never throw: every
 * failure is `{ ok: false, diagnostic, error, retryable }`.
 *
 * Diagnostics:
 *   web_search_unavailable  the platform cannot run web search right now
 *   invalid_parameters      fix the request (the error names the field)
 *   credits_exhausted       the workspace is out of credits (HTTP 402)
 *   rate_limited            too many calls for this app (HTTP 429), retry later
 *   upstream_rate_limited / upstream_error   the search provider failed, retry later
 *   production_authentication_unavailable   no broker credential in this env
 *
 * Platform side: chipp-deno `src/services/web-search.service.ts` and
 * `docs/web-search.md`.
 */

const WEB_SEARCH_BASE = "/api/internal/hosted-integration-broker/web-search";
const SEARCH_TIMEOUT_MS = 30_000;

export type WebSearchRecency = "hour" | "day" | "week" | "month" | "year";

export interface WebSearchOptions {
  /** "web" (default) for ranked pages, "news" for recent articles. */
  mode?: "web" | "news";
  /** 1 to 20, default 10. */
  maxResults?: number;
  /** Only results published within this window. Not together with publishedAfter/publishedBefore. */
  recency?: WebSearchRecency;
  /** YYYY-MM-DD bounds on the publication date. */
  publishedAfter?: string;
  publishedBefore?: string;
  /** Up to 10 bare domains ("reuters.com"); prefix "-" to exclude one. */
  domains?: string[];
  /** Two-letter country code to localize results ("US"). */
  country?: string;
  /** Language code for results ("en", "pt-br"). */
  language?: string;
}

export interface WebSearchResult {
  title: string;
  url: string;
  snippet: string;
  /** Publication date as YYYY-MM-DD, or null when unknown. */
  date: string | null;
  /** Always null today; kept for a stable shape. */
  lastUpdated: string | null;
  /** Host name of the result ("reuters.com"). */
  source: string;
  /** 1-based rank in this response. */
  position: number;
  /** News outlet name ("Reuters") in news mode, null in web mode. */
  publisher: string | null;
  /** The date text as Google showed it ("2 hours ago"), or null. */
  dateText: string | null;
}

export interface WebSearchCost {
  vendorMicrodollars: number;
  billedMicrodollars: number;
  billedUsd: number;
}

export interface WebSearchFailure {
  ok: false;
  diagnostic: string;
  error: string;
  retryable: boolean;
  /** Seconds to wait before retrying, when the platform sent one. */
  retryAfterSeconds?: number;
}

export type WebSearchResponse =
  | {
    ok: true;
    operation: "search";
    mode: "web" | "news";
    query: string;
    results: WebSearchResult[];
    cost: WebSearchCost;
  }
  | WebSearchFailure;

type Env = (name: string) => string | undefined;

function credential(env: Env): { origin: string; headers: Record<string, string> } | null {
  const origin = (env("CHIPP_INTEGRATION_BROKER_URL") ?? "").trim().replace(/\/+$/, "");
  const token = env("CHIPP_INTEGRATION_BROKER_TOKEN") ?? "";
  const projectId = env("PROJECT_ID") ?? "";
  const orgId = env("CHIPP_ORG_ID") ?? "";
  if (!origin || !token || !projectId || !orgId) return null;
  return {
    origin,
    headers: {
      "X-Alch-Broker-Auth": token,
      "x-alch-broker-project": projectId,
      "x-alch-broker-org": orgId,
      "content-type": "application/json",
    },
  };
}

export interface WebSearchClientDeps {
  fetchImpl?: typeof fetch;
  env?: Env;
}

/** POST one web search. Exported for tests. */
export async function postWebSearch<T>(
  body: Record<string, unknown>,
  deps: WebSearchClientDeps = {},
): Promise<T | WebSearchFailure> {
  const cfg = credential(deps.env ?? ((n) => Deno.env.get(n)));
  if (!cfg) {
    return {
      ok: false,
      diagnostic: "production_authentication_unavailable",
      error: "The Chipp broker credential is not in this environment. A fresh platform deploy injects it.",
      retryable: false,
    };
  }
  let res: Response;
  try {
    res = await (deps.fetchImpl ?? fetch)(`${cfg.origin}${WEB_SEARCH_BASE}/search`, {
      method: "POST",
      headers: cfg.headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS),
    });
  } catch (err) {
    return {
      ok: false,
      diagnostic: "upstream_error",
      error: `Could not reach Chipp web search: ${err instanceof Error ? err.message : String(err)}`,
      retryable: true,
    };
  }
  const parsed = await res.json().catch(() => null) as Record<string, unknown> | null;
  if (!parsed || typeof parsed !== "object") {
    return {
      ok: false,
      diagnostic: "upstream_error",
      error: `Chipp web search returned HTTP ${res.status} with an unreadable body.`,
      retryable: res.status === 424 || res.status === 429 || res.status >= 500,
    };
  }
  if (!res.ok || parsed.ok !== true) {
    const retryAfter = Number(res.headers.get("retry-after"));
    return {
      ok: false,
      diagnostic: typeof parsed.diagnostic === "string" ? parsed.diagnostic : "upstream_error",
      error: typeof parsed.error === "string" ? parsed.error : `Chipp web search failed (HTTP ${res.status}).`,
      retryable: typeof parsed.retryable === "boolean" ? parsed.retryable : res.status === 429 || res.status >= 500,
      ...(Number.isFinite(retryAfter) && retryAfter > 0 ? { retryAfterSeconds: retryAfter } : {}),
    };
  }
  return parsed as T;
}

/** Ranked live web results (or news, with `mode: "news"`) for `query`. */
export function webSearch(
  query: string,
  options: WebSearchOptions = {},
  deps?: WebSearchClientDeps,
): Promise<WebSearchResponse> {
  return postWebSearch<WebSearchResponse>({ ...options, query }, deps);
}
