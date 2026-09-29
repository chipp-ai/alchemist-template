/**
 * MPP (Machine Payments Protocol) integration -- Stripe's agentic payments
 * rail for machine-to-machine commerce. https://mpp.dev / mpp.dev docs at
 * https://docs.stripe.com/payments/machine/mpp
 *
 * What this enables: PAID MCP TOOLS. A tool registered with a `price` is
 * challenged at call time -- the caller gets a JSON-RPC error (code -32042)
 * carrying signed payment challenges; an MPP-capable agent pays (fiat card /
 * wallet via Stripe Shared Payment Tokens, or USDC on Tempo) and retries the
 * SAME call with the payment credential in
 * `_meta["org.paymentauth/credential"]`. On success the tool runs and the
 * result carries a receipt in `_meta["org.paymentauth/receipt"]`.
 *
 * Two payment methods, each env-gated:
 *
 *   FIAT (Stripe SPT)   STRIPE_SECRET_KEY + STRIPE_PROFILE_ID
 *                       Card/wallet via Stripe rails. Min charge 0.50 USD.
 *   CRYPTO (Tempo USDC) MPP_CRYPTO_ENABLED=1 + STRIPE_SECRET_KEY
 *                       On-chain USDC. Charges as low as 0.01 USD. Requires
 *                       the "Stablecoins and Crypto" payment method approved
 *                       on the Stripe account. MPP_CRYPTO_TESTNET=1 targets
 *                       the Tempo testnet (pathUSD).
 *
 * MPP_SECRET_KEY (required to enable either lane) signs payment challenges
 * (challenge binding, https://mpp.dev/protocol/challenges). It MUST be a
 * stable secret shared by every replica -- a per-boot random key would
 * invalidate challenges across pods/restarts.
 *
 * Payments land in the Stripe balance of the STRIPE_SECRET_KEY account (the
 * project owner's connected account on the Alchemist platform).
 */

import Stripe from "stripe";
import { Mppx, stripe as mppStripe, tempo, Transport } from "mppx/server";
import type { McpError } from "@modelcontextprotocol/sdk/types.js";
import { log } from "@/lib/logger.ts";

// Tempo USDC token contract addresses (from the Stripe MPP guide).
const TEMPO_USDC_MAINNET = "0x20c000000000000000000000b9537d11c60e8b50";
const TEMPO_PATHUSD_TESTNET = "0x20c0000000000000000000000000000000000000";

/** Per-tool price config (USD decimal strings, e.g. "0.50"). */
export interface ToolPrice {
  /** Fiat price via Stripe SPT (card/wallet). Stripe minimum is 0.50 USD. */
  fiatUsd?: string;
  /** Crypto price in USDC on Tempo. Can be as low as 0.01. */
  cryptoUsd?: string;
  /** Short human/agent-facing description appended to the tool description. */
  description?: string;
}

/** Result of a payment gate check for one tool call. */
export type PaymentGateResult =
  | { kind: "paid"; attachReceipt: <T>(result: T) => T }
  | { kind: "challenge"; error: McpError }
  | { kind: "unconfigured"; message: string };

interface MppConfig {
  secretKey: string;
  stripeSecretKey: string | null;
  stripeProfileId: string | null;
  cryptoEnabled: boolean;
  cryptoTestnet: boolean;
}

function readConfig(): MppConfig | null {
  const secretKey = Deno.env.get("MPP_SECRET_KEY") ?? "";
  if (!secretKey) return null;
  return {
    secretKey,
    stripeSecretKey: Deno.env.get("STRIPE_SECRET_KEY") || null,
    stripeProfileId: Deno.env.get("STRIPE_PROFILE_ID") || null,
    cryptoEnabled: Deno.env.get("MPP_CRYPTO_ENABLED") === "1",
    cryptoTestnet: Deno.env.get("MPP_CRYPTO_TESTNET") === "1",
  };
}

export function fiatConfigured(): boolean {
  const cfg = readConfig();
  return Boolean(cfg && cfg.stripeSecretKey && cfg.stripeProfileId);
}

export function cryptoConfigured(): boolean {
  const cfg = readConfig();
  return Boolean(cfg && cfg.cryptoEnabled && cfg.stripeSecretKey);
}

export function mppEnabled(): boolean {
  return fiatConfigured() || cryptoConfigured();
}

// ── Mppx instance (lazy; env-keyed so tests can reconfigure) ────────────────

// deno-lint-ignore no-explicit-any
let cachedInstance: any = null;
let cachedFingerprint = "";

// deno-lint-ignore no-explicit-any
function getMppx(cfg: MppConfig): any {
  const fingerprint = JSON.stringify(cfg);
  if (cachedInstance && cachedFingerprint === fingerprint) return cachedInstance;

  // deno-lint-ignore no-explicit-any
  const methods: any[] = [];
  if (cfg.cryptoEnabled && cfg.stripeSecretKey) {
    methods.push(
      tempo.charge({
        currency: cfg.cryptoTestnet ? TEMPO_PATHUSD_TESTNET : TEMPO_USDC_MAINNET,
        ...(cfg.cryptoTestnet ? { testnet: true } : {}),
      }),
    );
  }
  if (cfg.stripeSecretKey && cfg.stripeProfileId) {
    methods.push(
      mppStripe.charge({
        secretKey: cfg.stripeSecretKey,
        networkId: cfg.stripeProfileId,
        paymentMethodTypes: ["card", "link"],
      }),
    );
  }
  if (methods.length === 0) return null;

  cachedInstance = Mppx.create({
    methods,
    secretKey: cfg.secretKey,
    transport: Transport.mcpSdk(),
  });
  cachedFingerprint = fingerprint;
  return cachedInstance;
}

// ── Crypto deposit addresses (per-payment, cached) ──────────────────────────

// Crypto PaymentIntents require the 2026-03-04.preview API version -- built
// here (not src/lib/stripe.ts) so the pinned stable client stays untouched.
let cryptoStripe: Stripe | null = null;
function getCryptoStripe(secretKey: string): Stripe {
  if (!cryptoStripe) {
    cryptoStripe = new Stripe(secretKey, {
      // deno-lint-ignore no-explicit-any
      apiVersion: "2026-03-04.preview" as any,
    });
  }
  return cryptoStripe;
}

/**
 * Deposit addresses we minted, so a credential's declared recipient can be
 * validated as ours. In-process TTL cache: the signed challenge is the real
 * integrity boundary (challenges are HMAC-bound to MPP_SECRET_KEY); this is
 * defense-in-depth per the Stripe guide. NOTE for multi-replica deploys:
 * move this to Redis so a retry landing on another pod still validates.
 */
const depositAddressCache = new Map<string, number>();
const DEPOSIT_ADDRESS_TTL_MS = 5 * 60 * 1000;

function cacheAddress(addr: string): void {
  depositAddressCache.set(addr, Date.now() + DEPOSIT_ADDRESS_TTL_MS);
  // Opportunistic sweep.
  for (const [k, exp] of depositAddressCache) {
    if (exp < Date.now()) depositAddressCache.delete(k);
  }
}

function isCachedAddress(addr: string): boolean {
  const exp = depositAddressCache.get(addr);
  return exp !== undefined && exp > Date.now();
}

/** Create a fresh Tempo deposit address for one crypto payment (Stripe PI). */
async function createPayToAddress(cfg: MppConfig, amountUsd: string): Promise<string> {
  const stripeClient = getCryptoStripe(cfg.stripeSecretKey!);
  const amountCents = Math.round(Number(amountUsd) * 100);
  const paymentIntent = await stripeClient.paymentIntents.create({
    amount: amountCents,
    currency: "usd",
    payment_method_types: ["crypto"],
    payment_method_data: { type: "crypto" } as never,
    payment_method_options: {
      crypto: {
        mode: "deposit",
        deposit_options: { networks: ["tempo"] },
      },
    } as never,
    confirm: true,
  });

  const nextAction = paymentIntent.next_action as unknown as {
    crypto_display_details?: {
      deposit_addresses?: Record<string, { address?: string }>;
    };
  } | null;
  const address = nextAction?.crypto_display_details?.deposit_addresses?.tempo?.address;
  if (!address) {
    throw new Error("PaymentIntent did not return expected crypto deposit details");
  }
  cacheAddress(address);
  return address;
}

// ── The payment gate ─────────────────────────────────────────────────────────

const CREDENTIAL_META_KEY = "org.paymentauth/credential";

interface ToolExtra {
  _meta?: Record<string, unknown> | undefined;
  [key: string]: unknown;
}

function credentialFromExtra(extra: ToolExtra): {
  challenge?: { method?: string; request?: { recipient?: string } };
} | null {
  const cred = extra._meta?.[CREDENTIAL_META_KEY];
  if (!cred || typeof cred !== "object") return null;
  return cred as { challenge?: { method?: string; request?: { recipient?: string } } };
}

/**
 * Gate one paid tool call. Returns:
 *   paid          -- credential verified + charged; attach the receipt.
 *   challenge     -- no/invalid credential; throw the McpError (-32042 with
 *                    signed challenges) so the client can pay and retry.
 *   unconfigured  -- the tool is priced but no payment method is configured;
 *                    the caller should fail closed with a clear message.
 */
export async function gatePaidToolCall(
  toolName: string,
  price: ToolPrice,
  extra: ToolExtra,
): Promise<PaymentGateResult> {
  const cfg = readConfig();
  const mppx = cfg ? getMppx(cfg) : null;
  if (!cfg || !mppx) {
    return {
      kind: "unconfigured",
      message:
        `Tool "${toolName}" is a paid tool but this server has no payment method configured. ` +
        "The operator must set MPP_SECRET_KEY plus STRIPE_SECRET_KEY + STRIPE_PROFILE_ID " +
        "(fiat) and/or MPP_CRYPTO_ENABLED=1 (USDC on Tempo).",
    };
  }

  const wantFiat = Boolean(price.fiatUsd) && Boolean(cfg.stripeSecretKey && cfg.stripeProfileId);
  const wantCrypto = Boolean(price.cryptoUsd) && cfg.cryptoEnabled && Boolean(cfg.stripeSecretKey);
  if (!wantFiat && !wantCrypto) {
    return {
      kind: "unconfigured",
      message:
        `Tool "${toolName}" is priced, but none of its price lanes match the server's ` +
        "configured payment methods.",
    };
  }

  // Build the per-method charge handlers for THIS tool's price.
  // deno-lint-ignore no-explicit-any
  const handlers: Array<{ method: string; run: (extra: any) => Promise<any> }> = [];

  if (wantCrypto) {
    const credential = credentialFromExtra(extra);
    let recipient: string | null = null;
    if (credential?.challenge?.method === "tempo") {
      // Retry-with-credential: recipient comes from the SIGNED challenge the
      // credential echoes; require it to be one we minted.
      const declared = credential.challenge.request?.recipient;
      if (declared && isCachedAddress(declared)) recipient = declared;
    }
    if (!recipient && !credential) {
      // Fresh challenge: mint a deposit address for this payment.
      try {
        recipient = await createPayToAddress(cfg, price.cryptoUsd!);
      } catch (err) {
        // Crypto lane down (e.g. Stripe preview API rejects) -- log and fall
        // through to fiat-only rather than failing the whole call.
        log.warn("MPP crypto deposit-address creation failed", {
          source: "mpp",
          toolName,
        }, err as Error);
      }
    }
    if (recipient) {
      const r = recipient;
      handlers.push({
        method: "tempo",
        run: (x) => mppx.tempo.charge({ amount: price.cryptoUsd!, recipient: r })(x),
      });
    }
  }

  if (wantFiat) {
    handlers.push({
      method: "stripe",
      run: (x) =>
        mppx.stripe.charge({
          amount: price.fiatUsd!,
          currency: "usd",
          decimals: 2,
          description: price.description ?? `Tool call: ${toolName}`,
        })(x),
    });
  }

  if (handlers.length === 0) {
    return {
      kind: "unconfigured",
      message: `Tool "${toolName}" is priced but no payment lane is currently available.`,
    };
  }

  // Credential present -> dispatch to the matching method (it verifies the
  // signed challenge + charges). No credential -> run every handler to
  // collect challenges, then merge into ONE McpError so the agent can pick
  // a payment method.
  const credential = credentialFromExtra(extra);
  if (credential?.challenge?.method) {
    const match = handlers.find((h) => h.method === credential.challenge!.method) ?? handlers[0];
    const result = await match.run(extra);
    if (result.status === 402) return { kind: "challenge", error: result.challenge as McpError };
    return {
      kind: "paid",
      attachReceipt: <T>(toolResult: T): T => result.withReceipt(toolResult) as T,
    };
  }

  // deno-lint-ignore no-explicit-any
  const challengeErrors: any[] = [];
  for (const handler of handlers) {
    const result = await handler.run(extra);
    if (result.status === 200) {
      // Shouldn't happen without a credential, but honor it.
      return {
        kind: "paid",
        attachReceipt: <T>(toolResult: T): T => result.withReceipt(toolResult) as T,
      };
    }
    challengeErrors.push(result.challenge);
  }

  // Merge challenges from every lane into the first error's data.
  const primary = challengeErrors[0] as McpError & {
    data?: { challenges?: unknown[] };
  };
  const allChallenges = challengeErrors.flatMap((e) =>
    (e?.data as { challenges?: unknown[] } | undefined)?.challenges ?? []
  );
  if (primary?.data && Array.isArray(primary.data.challenges)) {
    primary.data.challenges = allChallenges as never;
  }
  return { kind: "challenge", error: primary };
}

/** "$0.50 (card/wallet) or $0.05 (USDC)" -- for tool descriptions. */
export function formatToolPrice(price: ToolPrice): string {
  const parts: string[] = [];
  if (price.fiatUsd) parts.push(`$${price.fiatUsd} (card/wallet via Stripe)`);
  if (price.cryptoUsd) parts.push(`$${price.cryptoUsd} (USDC)`);
  return parts.join(" or ");
}

/** MCP metadata key for payment-required tool results (paymentauth spec). */
export const PAYMENT_REQUIRED_META_KEY = "org.paymentauth/payment-required";
/** MCP metadata key for receipts on paid tool results. */
export const RECEIPT_META_KEY = "org.paymentauth/receipt";

/**
 * Convert a payment challenge (McpError -32042 from the mppx transport) into
 * a TOOL RESULT the high-level MCP SDK can deliver intact.
 *
 * Why not `throw`: `McpServer.registerTool` wraps thrown errors into a bare
 * text result, which would STRIP `error.data.challenges`. The paymentauth
 * spec supports a second wire shape for exactly this: a result carrying
 * `_meta["org.paymentauth/payment-required"]` -- mppx MCP clients detect it
 * (getPaymentRequiredMeta) and retry with payment, while non-paying clients
 * (Claude Desktop et al) see the honest human-readable text.
 */
export function paymentRequiredToolResult(
  toolName: string,
  price: ToolPrice,
  error: McpError,
): {
  isError: true;
  content: Array<{ type: "text"; text: string }>;
  _meta: Record<string, unknown>;
} {
  const data = (error as { data?: { challenges?: unknown[]; problem?: unknown } }).data ?? {};
  return {
    isError: true,
    content: [{
      type: "text",
      text:
        `Payment required: "${toolName}" costs ${formatToolPrice(price)} per call. ` +
        "This server accepts MPP machine payments (https://mpp.dev). If your agent runtime " +
        "supports MPP (mppx client, @stripe/link-cli), pay one of the attached challenges and " +
        "retry this call with the credential in _meta[\"org.paymentauth/credential\"]. " +
        "If it does not, tell the user this tool is paid and cannot be used from this client. " +
        "Do NOT retry without payment.",
    }],
    _meta: {
      [PAYMENT_REQUIRED_META_KEY]: {
        challenges: data.challenges ?? [],
        ...(data.problem ? { problem: data.problem } : {}),
      },
    },
  };
}
