/**
 * Billing-correct, multimodal-capable Anthropic Messages client + forced
 * structured-output helper. Ported from the Valor Victoria customer repo
 * (src/services/llm/client.ts) and adapted to this template's LLM_CONFIG.
 *
 * Every request goes through the platform's per-tenant LLM proxy at
 * `${LLM_CONFIG.baseUrl}/api/llm/messages` with the proxy's internal-worker
 * auth (`x-api-key` + `X-Internal-Tenant-Id`, NOT `Authorization: Bearer`) --
 * NEVER directly to a provider -- so each call debits the tenant credit
 * ledger (the platform billing invariant). A direct provider call is a
 * billing bypass and is rejected (see the provider-host guard below).
 *
 * This module is email-independent: it is the app's general structured-
 * extraction capability. The inbound-email pipeline is merely its first
 * consumer (src/services/inbound-email/extract.service.ts).
 *
 * Fail-closed: when the proxy is unconfigured every call throws
 * `LlmNotConfiguredError` BEFORE any network I/O -- never a silent no-op,
 * never a direct provider fallback.
 *
 * NEVER log or echo the proxy token. Error messages carry only the HTTP
 * status + a truncated body prefix.
 */

import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { AppError } from "@/utils/errors.ts";
import { log } from "@/lib/logger.ts";
import { LLM_CONFIG } from "@/config/llm.ts";

const LOG_SOURCE = "llm-extraction";
const MESSAGES_PATH = "/api/llm/messages";

/** Anthropic Messages API version pinned on every proxied request. */
export const ANTHROPIC_VERSION = "2023-06-01";

/**
 * Default extraction model. Vision/document capable. Env-overridable via
 * `LLM_MODEL` (read LAZILY per call, not at module load, for testability) --
 * never hard-code a model id at a call site.
 */
export const DEFAULT_LLM_MODEL = "claude-sonnet-4-6";

/** Default max output tokens when a request does not specify one. */
export const DEFAULT_LLM_MAX_TOKENS = 4096;

/** Env read that never throws (some test contexts run without --allow-env). */
function safeEnv(key: string): string | undefined {
  try {
    return Deno.env.get(key);
  } catch {
    return undefined;
  }
}

/** Resolve the model id: per-call override > `LLM_MODEL` env > default. */
export function resolveLlmModel(override?: string): string {
  const o = (override ?? "").trim();
  if (o) return o;
  const env = (safeEnv("LLM_MODEL") ?? "").trim();
  return env || DEFAULT_LLM_MODEL;
}

// ── Typed errors ─────────────────────────────────────────────────────

/**
 * The proxy creds are unconfigured. Thrown BEFORE any network I/O so an
 * unconfigured pod fails closed. 500 -- a deployment/config gap on our
 * side, not a bad request from a user.
 */
export class LlmNotConfiguredError extends AppError {
  constructor(
    message = "LLM proxy is not configured: set LLM_PROXY_BASE_URL, WORKER_LLM_PROXY_TOKEN and " +
      "LLM_PROXY_TENANT_ID. Refusing to call a provider directly (billing bypass).",
  ) {
    super(message, 500, "LLM_NOT_CONFIGURED");
    this.name = "LlmNotConfiguredError";
  }
}

/**
 * The proxy returned a non-2xx response, or its body did not contain the
 * expected content. 502 -- an upstream/proxy failure, not our-side input.
 * Carries the HTTP `.status` (0 when the failure was not an HTTP status,
 * e.g. an unparseable body or a missing tool_use block).
 */
export class LlmRequestError extends AppError {
  public readonly status: number;
  constructor(message: string, status = 0) {
    super(message, 502, "LLM_REQUEST_ERROR");
    this.name = "LlmRequestError";
    this.status = status;
  }
}

/**
 * HTTP 402 from the platform billing proxy: the tenant's credit balance is
 * depleted. An entitlement condition, NOT an our-side code bug -- callers
 * apply a long backoff and self-resolve once the tenant tops up. Subclass
 * of `LlmRequestError` so catch-all callers behave uniformly.
 */
export class LlmCreditsExhaustedError extends LlmRequestError {
  constructor(message: string) {
    super(message, 402);
    this.name = "LlmCreditsExhaustedError";
  }
}

/**
 * The forced tool_use response could not be parsed/validated against the
 * caller's zod schema (missing tool_use block, omitted `result` wrapper,
 * or a zod validation failure). 502 -- the model broke the output contract.
 */
export class LlmExtractionError extends AppError {
  constructor(message: string) {
    super(message, 502, "LLM_EXTRACTION_ERROR");
    this.name = "LlmExtractionError";
  }
}

/**
 * Classify a proxy HTTP failure for log severity + retryability.
 * External/transient conditions the proxy or provider surfaces
 * (auth/entitlement, credit exhaustion, throttle, timeout, upstream 5xx)
 * are NOT our-side bugs -> `warn`. Malformed requests we control
 * (400/404/409/422) are our-side -> `error`.
 */
export function isExpectedLlmProxyStatus(status: number): boolean {
  return status === 401 || status === 402 || status === 403 ||
    status === 408 || status === 429 || status >= 500;
}

/**
 * True for a TRANSIENT/external proxy failure (auth/entitlement, throttle,
 * timeout, upstream 5xx). Returns `false` for non-`LlmRequestError` values
 * and for our-side statuses (including status 0 -- unparseable body /
 * missing tool_use) so a real regression never hides behind it.
 */
export function isTransientLlmError(err: unknown): err is LlmRequestError {
  return err instanceof LlmRequestError && isExpectedLlmProxyStatus(err.status);
}

// ── Provider-host guard ──────────────────────────────────────────────

/**
 * LLM-provider hostnames the proxy base URL must NEVER resolve to.
 * Pointing the base URL at a provider would (a) bypass the credit ledger
 * and (b) ship the per-tenant proxy worker token to a third party.
 * Matched as an exact host OR any subdomain.
 */
const BLOCKED_PROVIDER_HOSTS = ["anthropic.com", "openai.com"] as const;

function isProviderHost(baseUrl: string): boolean {
  if (!baseUrl) return false;
  let host: string;
  try {
    host = new URL(baseUrl).hostname.toLowerCase();
  } catch {
    return false;
  }
  return BLOCKED_PROVIDER_HOSTS.some((h) => host === h || host.endsWith("." + h));
}

// ── Content blocks (Anthropic Messages API shapes) ───────────────────

export interface TextBlock {
  type: "text";
  text: string;
}

export interface ImageBlock {
  type: "image";
  source: { type: "base64"; media_type: string; data: string };
}

export interface DocumentBlock {
  type: "document";
  source: { type: "base64"; media_type: "application/pdf"; data: string };
}

export type ContentBlock = TextBlock | ImageBlock | DocumentBlock;

export function textBlock(text: string): TextBlock {
  return { type: "text", text };
}

/** Image content block. `mediaType` e.g. "image/png", "image/jpeg". */
export function imageBlock(mediaType: string, base64Data: string): ImageBlock {
  return { type: "image", source: { type: "base64", media_type: mediaType, data: base64Data } };
}

/** PDF document content block (the vision model reads the PDF directly). */
export function pdfBlock(base64Data: string): DocumentBlock {
  return {
    type: "document",
    source: { type: "base64", media_type: "application/pdf", data: base64Data },
  };
}

// ── Messages passthrough types ───────────────────────────────────────

export type MessageRole = "user" | "assistant";

export interface AnthropicMessage {
  role: MessageRole;
  content: string | ContentBlock[];
}

export interface AnthropicTool {
  name: string;
  description?: string;
  input_schema: Record<string, unknown>;
}

export type ToolChoice =
  | { type: "auto" }
  | { type: "any" }
  | { type: "tool"; name: string };

export interface MessagesRequest {
  messages: AnthropicMessage[];
  system?: string;
  tools?: AnthropicTool[];
  tool_choice?: ToolChoice;
  model?: string;
  max_tokens?: number;
}

/** Minimal shape of the Anthropic Messages response we depend on. */
export interface ResponseContentBlock {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
}

export interface MessagesResponse {
  id?: string;
  model?: string;
  role?: string;
  stop_reason?: string;
  content: ResponseContentBlock[];
  usage?: Record<string, unknown>;
}

// ── Test seams ───────────────────────────────────────────────────────

/**
 * `LLM_CONFIG` is frozen at module load, so tests can't flip `configured`
 * by setting env vars. This override lets tests simulate a configured pod
 * (pair with a stubbed `globalThis.fetch` or `__setLlmFetchForTest`).
 * Production code never calls it.
 */
let configOverride:
  | { baseUrl: string; proxyToken: string; tenantId: string }
  | null = null;

export function __setLlmConfigOverrideForTest(
  override: { baseUrl: string; proxyToken: string; tenantId: string } | null,
): void {
  configOverride = override;
}

function effectiveConfig(): {
  baseUrl: string;
  proxyToken: string;
  tenantId: string;
  configured: boolean;
} {
  if (configOverride) {
    return {
      ...configOverride,
      configured: Boolean(
        configOverride.baseUrl && configOverride.proxyToken && configOverride.tenantId,
      ),
    };
  }
  return {
    baseUrl: LLM_CONFIG.baseUrl,
    proxyToken: LLM_CONFIG.proxyToken,
    tenantId: LLM_CONFIG.tenantId,
    configured: LLM_CONFIG.configured,
  };
}

let fetchImpl: typeof fetch = globalThis.fetch;

/** Test hook -- inject a fetch stub. Pair with `__resetLlmFetchForTest()`. */
export function __setLlmFetchForTest(fn: typeof fetch): void {
  fetchImpl = fn;
}

/** Restore the real fetch. */
export function __resetLlmFetchForTest(): void {
  fetchImpl = globalThis.fetch;
}

// ── Messages passthrough ─────────────────────────────────────────────

/**
 * Thin Anthropic Messages-API passthrough through the billing proxy.
 *
 * Fails closed when unconfigured (throws `LlmNotConfiguredError` before
 * any fetch). On HTTP 402 throws `LlmCreditsExhaustedError`; on any other
 * non-2xx logs at the classified severity (never the token) and throws
 * `LlmRequestError` with the status + a truncated body prefix.
 */
export async function llmMessages(req: MessagesRequest): Promise<MessagesResponse> {
  const cfg = effectiveConfig();
  if (!cfg.configured) {
    throw new LlmNotConfiguredError();
  }
  // Fail closed if the base URL was misconfigured to a provider host --
  // that would bypass the credit ledger AND leak the proxy worker token.
  // Pre-network, so the token is never transmitted off-platform.
  if (isProviderHost(cfg.baseUrl)) {
    throw new LlmNotConfiguredError(
      "LLM_PROXY_BASE_URL points at an LLM-provider host -- refusing to call a " +
        "provider directly: that bypasses the credit ledger and leaks the " +
        "per-tenant proxy token. Point it at the platform proxy origin.",
    );
  }

  const url = `${cfg.baseUrl.replace(/\/+$/, "")}${MESSAGES_PATH}`;
  const body: Record<string, unknown> = {
    model: resolveLlmModel(req.model),
    max_tokens: req.max_tokens ?? DEFAULT_LLM_MAX_TOKENS,
    messages: req.messages,
  };
  if (req.system !== undefined) body.system = req.system;
  if (req.tools !== undefined) body.tools = req.tools;
  if (req.tool_choice !== undefined) body.tool_choice = req.tool_choice;

  const res = await fetchImpl(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      // Platform proxy internal-worker auth: the shared worker secret rides
      // as x-api-key (NOT Authorization: Bearer), and the tenant the spend
      // bills to rides as X-Internal-Tenant-Id.
      "x-api-key": cfg.proxyToken,
      "X-Internal-Tenant-Id": cfg.tenantId,
      "anthropic-version": ANTHROPIC_VERSION,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    const ctx = {
      source: LOG_SOURCE,
      feature: "proxy",
      status: res.status,
      model: body.model,
      bodyPrefix: text.slice(0, 200),
    };
    if (isExpectedLlmProxyStatus(res.status)) {
      // External/transient -- never our-side bug. warn, don't error.
      log.warn("LLM proxy request failed", ctx);
    } else {
      log.error("LLM proxy request failed", ctx);
    }
    const message = `LLM proxy ${res.status}: ${text.slice(0, 200)}`;
    if (res.status === 402) {
      throw new LlmCreditsExhaustedError(message);
    }
    throw new LlmRequestError(message, res.status);
  }

  const json = await res.json().catch(() => null) as MessagesResponse | null;
  if (!json || !Array.isArray(json.content)) {
    log.error("LLM proxy returned an unparseable body", {
      source: LOG_SOURCE,
      feature: "proxy",
      model: body.model,
    });
    throw new LlmRequestError("LLM proxy returned an unparseable body");
  }
  return json;
}

// ── Structured-output helper ─────────────────────────────────────────

export interface ExtractStructuredOptions<S extends z.ZodTypeAny> {
  /** Zod schema the result is validated against (also drives the tool input_schema). */
  schema: S;
  /** User content -- multimodal content blocks. */
  content: ContentBlock[];
  /** System prompt. */
  system: string;
  /** Tool name the model is forced to call. */
  toolName: string;
  /** Max output tokens override (default DEFAULT_LLM_MAX_TOKENS). */
  maxTokens?: number;
  /** Model override (default: LLM_MODEL env / DEFAULT_LLM_MODEL). */
  model?: string;
}

/** Summarize zod issues for a diagnosable (but bounded) error message. */
function summarizeZodIssues(err: z.ZodError): string {
  return err.issues
    .slice(0, 5)
    .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
    .join("; ")
    .slice(0, 500);
}

/**
 * Force structured (tool-call) output and return the zod-validated object.
 *
 * The caller's schema is wrapped under a uniform `result` property so
 * object / discriminated-union / array / primitive schemas all serialize
 * to a valid object-typed `input_schema` (Anthropic requires the top-level
 * tool input_schema to be an object). `$refStrategy: "none"` inlines
 * everything (no $ref the provider may not resolve).
 *
 * Throws `LlmExtractionError` when the response omits the tool_use block,
 * omits the `result` wrapper, or fails zod validation.
 */
export async function extractStructured<S extends z.ZodTypeAny>(
  opts: ExtractStructuredOptions<S>,
): Promise<z.infer<S>> {
  const wrapper = z.object({ result: opts.schema });
  const inputSchema = zodToJsonSchema(wrapper, { $refStrategy: "none" }) as
    & Record<string, unknown>
    & { $schema?: unknown };
  delete inputSchema.$schema;

  const tool: AnthropicTool = {
    name: opts.toolName,
    description: "Return the extracted structured data via this tool.",
    input_schema: inputSchema,
  };

  const response = await llmMessages({
    system: opts.system,
    messages: [{ role: "user", content: opts.content }],
    tools: [tool],
    tool_choice: { type: "tool", name: opts.toolName },
    model: opts.model,
    max_tokens: opts.maxTokens,
  });

  const toolUse = response.content.find(
    (b) => b.type === "tool_use" && b.name === opts.toolName,
  );
  if (!toolUse || !toolUse.input || typeof toolUse.input !== "object") {
    throw new LlmExtractionError(
      `LLM response did not include a '${opts.toolName}' tool_use block`,
    );
  }

  // The forced tool wraps the payload under `result`. The model occasionally
  // omits the wrapper entirely; intercept that with a descriptive error
  // instead of an opaque top-level ZodError. The key list is capped -- the
  // input is model output influenced by untrusted email content.
  const raw = (toolUse.input as { result?: unknown }).result;
  if (raw === undefined) {
    const keyList = Object.keys(toolUse.input as Record<string, unknown>)
      .join(", ")
      .slice(0, 500);
    throw new LlmExtractionError(
      `LLM '${opts.toolName}' tool_use omitted the required 'result' field ` +
        `(input keys: ${keyList || "none"})`,
    );
  }

  const parsed = opts.schema.safeParse(raw);
  if (!parsed.success) {
    throw new LlmExtractionError(
      `LLM '${opts.toolName}' output failed schema validation: ${summarizeZodIssues(parsed.error)}`,
    );
  }
  return parsed.data;
}
