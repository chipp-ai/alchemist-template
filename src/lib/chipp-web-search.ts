/**
 * Chipp web search client (Perplexity).
 *
 * Live web data for this app's SERVER code: news tracking, research, market
 * intel, fact-checking. The Chipp platform holds the Perplexity account and
 * key; this app holds only the broker credential the platform injects at
 * deploy time (the same env `src/lib/chipp-integrations.ts` reads). There is
 * nothing to connect and no API key to ask for.
 *
 *   webSearch(query, options)    ranked results: title, url, snippet, date, source
 *   webAnswer(question, options) a short written answer plus its sources
 *
 * Every call is billed to the workspace's Chipp credits (about $0.0065 per
 * search, $0.0013 with mode "fast"; an answer is Perplexity's cost plus 30%,
 * usually under $0.02). Cache what many people see, and show the source link
 * with every result.
 *
 * Server only: never import this from `web/`. Calls never throw: every
 * failure is `{ ok: false, diagnostic, error, retryable }`.
 *
 * Diagnostics:
 *   web_search_unavailable  the platform has not enabled web search yet
 *   invalid_parameters      fix the request (the error names the field)
 *   credits_exhausted       the workspace is out of credits (HTTP 402)
 *   rate_limited            too many calls for this app (HTTP 429), retry later
 *   upstream_rate_limited / upstream_error   Perplexity failed, retry later
 *   production_authentication_unavailable   no broker credential in this env
 *
 * Platform side: chipp-deno `src/services/perplexity-web-search.service.ts`
 * and `docs/web-search-perplexity.md`.
 */

const WEB_SEARCH_BASE = "/api/internal/hosted-integration-broker/web-search";
const SEARCH_TIMEOUT_MS = 30_000;
const ANSWER_TIMEOUT_MS = 75_000;

export type WebSearchRecency = "hour" | "day" | "week" | "month" | "year";

export interface WebSearchFilters {
  /** Only results published within this window. */
  recency?: WebSearchRecency;
  /** Up to 10 bare domains ("reuters.com"); prefix "-" to exclude one. */
  domains?: string[];
  /** Two-letter country code to localize results ("US"). */
  country?: string;
  /** YYYY-MM-DD bounds on the publication date. */
  publishedAfter?: string;
  publishedBefore?: string;
}

export interface WebSearchOptions extends WebSearchFilters {
  /** 1 to 20, default 10. */
  maxResults?: number;
  /** "fast" is cheaper and quicker, with slightly lower quality. Default "web". */
  mode?: "web" | "fast";
}

export interface WebAnswerOptions extends WebSearchFilters {
  /** 64 to 2048, default 1024. */
  maxOutputTokens?: number;
  /** Results per search the answer may read, 1 to 10, default 5. */
  maxSources?: number;
}

export interface WebSearchResult {
  title: string;
  url: string;
  snippet: string;
  /** Publication date as reported (often YYYY-MM-DD), or null. */
  date: string | null;
  lastUpdated: string | null;
  /** Host name of the result ("reuters.com"). */
  source: string;
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
  | { ok: true; operation: "search"; query: string; results: WebSearchResult[]; cost: WebSearchCost }
  | WebSearchFailure;

export type WebAnswerResponse =
  | {
    ok: true;
    operation: "answer";
    question: string;
    /** May contain inline citation markers such as [1] or [web:1]. */
    answer: string;
    sources: WebSearchResult[];
    model: string;
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

/** POST one web-search operation. Exported for tests. */
export async function postWebSearch<T>(
  operation: "search" | "answer",
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
    res = await (deps.fetchImpl ?? fetch)(`${cfg.origin}${WEB_SEARCH_BASE}/${operation}`, {
      method: "POST",
      headers: cfg.headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(operation === "search" ? SEARCH_TIMEOUT_MS : ANSWER_TIMEOUT_MS),
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

/** Ranked live web results for `query`. */
export function webSearch(
  query: string,
  options: WebSearchOptions = {},
  deps?: WebSearchClientDeps,
): Promise<WebSearchResponse> {
  return postWebSearch<WebSearchResponse>("search", { ...options, query }, deps);
}

/** A short written answer to `question`, with the sources it used. */
export function webAnswer(
  question: string,
  options: WebAnswerOptions = {},
  deps?: WebSearchClientDeps,
): Promise<WebAnswerResponse> {
  return postWebSearch<WebAnswerResponse>("answer", { ...options, question }, deps);
}
