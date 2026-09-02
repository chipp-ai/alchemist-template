/**
 * Chipp hosted-integration broker client.
 *
 * Gives THIS app's server code first-party access to the Chipp platform's
 * HOSTED INTEGRATIONS (Google Calendar, Google Drive, Notion, ...) with no
 * OAuth client, no provider secret, and no token ever existing in this
 * codebase. The platform holds the connections; this pod holds only an
 * org+project-bound HMAC credential injected at deploy time.
 *
 * ALWAYS check this lane before building a bespoke OAuth connector or
 * requesting GOOGLE_CLIENT_ID-style credentials: if the provider exists in
 * the platform catalog, the connect + invoke problem is already solved.
 *
 * Env (injected into every managed pod by the Chipp rollout controller;
 * see chipp-deno docs/alchemist/hosted-integration-broker.md):
 *   - CHIPP_INTEGRATION_BROKER_URL   platform API origin
 *   - CHIPP_INTEGRATION_BROKER_TOKEN org+project-bound credential
 *   - CHIPP_ORG_ID                   this project's organization id
 *   - PROJECT_ID                     this project's id
 *
 * All three calls degrade gracefully when the env is absent (older deploys
 * that predate the injection): they return a `configured: false` /
 * `production_authentication_unavailable`-shaped result instead of throwing.
 *
 * Flow for a feature like "show the customer's Google Calendar":
 *   1. `listHostedIntegrations({ provider: "google-calendar" })` -- is a
 *      connection live on one of the org's agent applications?
 *   2. Not connected -> `createIntegrationConnectLink(applicationId,
 *      "google-calendar")` and show/send the returned URL; the user
 *      completes Google's consent screen on the platform.
 *   3. Connected -> `invokeHostedIntegration(applicationId,
 *      "google_calendar_list_events", { ... })` and render the redacted
 *      envelope's result.
 */

const BROKER_BASE = "/api/internal/hosted-integration-broker";
const CALL_TIMEOUT_MS = 20_000;

export interface ChippIntegrationEnvelope {
  ok: boolean;
  diagnostic: string;
  provider?: string | null;
  toolName?: string;
  summary?: string;
  [key: string]: unknown;
}

function brokerConfig(): {
  configured: boolean;
  origin: string;
  headers: Record<string, string>;
} {
  const origin = (Deno.env.get("CHIPP_INTEGRATION_BROKER_URL") ?? "").trim()
    .replace(/\/+$/, "");
  const token = Deno.env.get("CHIPP_INTEGRATION_BROKER_TOKEN") ?? "";
  const projectId = Deno.env.get("PROJECT_ID") ?? "";
  const orgId = Deno.env.get("CHIPP_ORG_ID") ?? "";
  return {
    configured: Boolean(origin && token && projectId && orgId),
    origin,
    headers: {
      "X-Alch-Broker-Auth": token,
      "x-alch-broker-project": projectId,
      "x-alch-broker-org": orgId,
    },
  };
}

const NOT_CONFIGURED: ChippIntegrationEnvelope = {
  ok: false,
  diagnostic: "production_authentication_unavailable",
  summary:
    "The hosted-integration broker credential is not present in this pod's " +
    "environment (CHIPP_INTEGRATION_BROKER_URL / _TOKEN / CHIPP_ORG_ID / " +
    "PROJECT_ID). A fresh platform deploy of this project injects it.",
};

async function brokerFetch(
  path: string,
  init: RequestInit,
): Promise<ChippIntegrationEnvelope> {
  const cfg = brokerConfig();
  if (!cfg.configured) return { ...NOT_CONFIGURED };
  try {
    const res = await fetch(`${cfg.origin}${BROKER_BASE}${path}`, {
      ...init,
      headers: { ...cfg.headers, ...(init.headers ?? {}) },
      signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
    });
    const body = await res.json().catch(() => null) as
      | ChippIntegrationEnvelope
      | null;
    if (!body) {
      return {
        ok: false,
        diagnostic: res.ok ? "execution_error" : "production_authentication_unavailable",
        summary: `The platform returned HTTP ${res.status} with an unparseable body.`,
      };
    }
    return body;
  } catch (err) {
    return {
      ok: false,
      diagnostic: "production_authentication_unavailable",
      summary: `Could not reach the platform integration broker: ${
        err instanceof Error ? err.message : String(err)
      }`,
    };
  }
}

/**
 * List the hosted-integration catalog + this org's live connections. Pass
 * `provider` to narrow to one provider and receive full JSON-schema
 * parameters for each of its tools.
 */
export async function listHostedIntegrations(
  opts: { provider?: string } = {},
): Promise<ChippIntegrationEnvelope> {
  const qs = opts.provider ? `?provider=${encodeURIComponent(opts.provider)}` : "";
  return await brokerFetch(`/integrations${qs}`, { method: "GET" });
}

/**
 * Invoke a hosted-integration tool (e.g. `google_calendar_list_events`) for
 * one of the org's platform agent applications. The provider call executes
 * on the platform; only a redacted envelope comes back.
 */
export async function invokeHostedIntegration(
  applicationId: string,
  toolName: string,
  parameters: Record<string, unknown> = {},
): Promise<ChippIntegrationEnvelope> {
  return await brokerFetch("/integrations/invoke", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ applicationId, toolName, parameters }),
  });
}

/**
 * Mint a durable (~7-day) signed connect link for `(applicationId,
 * provider)`. Show or send the returned `connectUrl` to whoever owns the
 * account; completing it stores the connection on the platform.
 */
export async function createIntegrationConnectLink(
  applicationId: string,
  provider: string,
): Promise<ChippIntegrationEnvelope> {
  return await brokerFetch("/integrations/connect-link", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ applicationId, provider }),
  });
}
