/**
 * MPP (Machine Payments Protocol) integration -- Stripe's agentic payments
 * rail, HTTP flavor. https://docs.stripe.com/payments/machine/mpp
 *
 * What this enables: PAID API ROUTES. A route wrapped in `mppPaid(price)`
 * (src/api/middleware/monetize.ts) answers unpaid requests with HTTP 402 +
 * signed `WWW-Authenticate: Payment` challenges; an MPP-capable agent
 * (mppx client, @stripe/link-cli) pays and retries the SAME request with an
 * `Authorization: Payment ...` credential. Verified requests run the route
 * and the response carries a payment receipt header.
 *
 * Three payment methods, each env-gated:
 *
 *   FIAT (Stripe SPT)   STRIPE_SECRET_KEY + STRIPE_PROFILE_ID
 *                       Card/wallet via Stripe rails. Min charge 0.50 USD.
 *                       Settles into the Stripe balance.
 *   CRYPTO (Tempo USDC) MPP_CRYPTO_ENABLED=1 + STRIPE_SECRET_KEY
 *                       On-chain USDC, charges as low as 0.01 USD. Requires
 *                       the "Stablecoins and Crypto" payment method approved
 *                       on the Stripe account. MPP_CRYPTO_TESTNET=1 targets
 *                       the Tempo testnet (pathUSD). Settles into the Stripe
 *                       balance (Stripe-managed deposit addresses).
 *   X402 (Base USDC)    MPP_X402_RECIPIENT (0x wallet) [+ MPP_X402_FACILITATOR]
 *                       The open x402 protocol (x402.org, Linux Foundation)
 *                       -- reaches the existing x402 agent ecosystem on
 *                       Base; challenges ride BOTH the MPP WWW-Authenticate
 *                       header AND the x402 X-Payment-Required header.
 *                       Settles ON-CHAIN to YOUR wallet, NOT the Stripe
 *                       balance; a facilitator verifies/settles (default on
 *                       testnet: https://x402.org/facilitator; mainnet
 *                       REQUIRES an explicit facilitator URL, e.g. Coinbase
 *                       CDP). MPP_X402_TESTNET=1 targets Base Sepolia.
 *
 * MPP_SECRET_KEY (required to enable either lane) signs payment challenges
 * (challenge binding, https://mpp.dev/protocol/challenges). It MUST be a
 * stable secret shared by every replica.
 */

import Stripe from "stripe";
import { Credential } from "mppx";
import { evm, Mppx, stripe as mppStripe, tempo } from "mppx/server";
import { log } from "@/lib/logger.ts";

// Tempo USDC token contract addresses (from the Stripe MPP guide).
const TEMPO_USDC_MAINNET = "0x20c000000000000000000000b9537d11c60e8b50";
const TEMPO_PATHUSD_TESTNET = "0x20c0000000000000000000000000000000000000";

/** Per-route price config (USD decimal strings, e.g. "0.50"). */
export interface RoutePrice {
  /** Fiat price via Stripe SPT (card/wallet). Stripe minimum is 0.50 USD. */
  fiatUsd?: string;
  /** Crypto price in USDC on Tempo. Can be as low as 0.01. */
  cryptoUsd?: string;
  /** Short description shown on payment surfaces. */
  description?: string;
}

export type HttpPaymentGateResult =
  | { kind: "paid"; attachReceipt: (res: Response) => Response }
  | { kind: "challenge"; response: Response }
  | { kind: "unconfigured"; message: string };

const X402_DEFAULT_TESTNET_FACILITATOR = "https://x402.org/facilitator";
const EVM_ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

interface MppConfig {
  secretKey: string;
  stripeSecretKey: string | null;
  stripeProfileId: string | null;
  cryptoEnabled: boolean;
  cryptoTestnet: boolean;
  x402Recipient: string | null;
  x402Facilitator: string | null;
  x402Testnet: boolean;
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
    x402Recipient: Deno.env.get("MPP_X402_RECIPIENT") || null,
    x402Facilitator: Deno.env.get("MPP_X402_FACILITATOR") || null,
    x402Testnet: Deno.env.get("MPP_X402_TESTNET") === "1",
  };
}

/**
 * The x402 lane is on when a VALID 0x recipient is set and a facilitator is
 * resolvable (testnet has a public default; mainnet requires an explicit
 * facilitator URL -- fail closed rather than settle against the wrong one).
 */
function x402Config(cfg: MppConfig): { recipient: `0x${string}`; facilitator: string } | null {
  if (!cfg.x402Recipient || !EVM_ADDRESS_RE.test(cfg.x402Recipient)) return null;
  const facilitator = cfg.x402Facilitator ??
    (cfg.x402Testnet ? X402_DEFAULT_TESTNET_FACILITATOR : null);
  if (!facilitator) return null;
  return { recipient: cfg.x402Recipient as `0x${string}`, facilitator };
}

export function mppEnabled(): boolean {
  const cfg = readConfig();
  if (!cfg) return false;
  return Boolean(
    (cfg.stripeSecretKey && cfg.stripeProfileId) ||
      (cfg.cryptoEnabled && cfg.stripeSecretKey) ||
      x402Config(cfg),
  );
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
  const x402 = x402Config(cfg);
  if (x402) {
    methods.push(
      evm.charge({
        currency: cfg.x402Testnet ? evm.assets.baseSepolia.USDC : evm.assets.base.USDC,
        recipient: x402.recipient,
        x402: { facilitator: x402.facilitator },
      }),
    );
  }
  if (methods.length === 0) return null;

  // Default transport is HTTP (Request in, 402/200 out) -- exactly what the
  // route middleware needs.
  cachedInstance = Mppx.create({ methods, secretKey: cfg.secretKey });
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
 * integrity boundary (HMAC-bound to MPP_SECRET_KEY); this is
 * defense-in-depth per the Stripe guide. NOTE for multi-replica deploys:
 * move this to Redis so a retry landing on another pod still validates.
 */
const depositAddressCache = new Map<string, number>();
const DEPOSIT_ADDRESS_TTL_MS = 5 * 60 * 1000;

function cacheAddress(addr: string): void {
  depositAddressCache.set(addr, Date.now() + DEPOSIT_ADDRESS_TTL_MS);
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

/**
 * Resolve the crypto recipient for THIS request: a retry carrying a tempo
 * credential echoes the recipient from its signed challenge (require it to
 * be one we minted); a fresh request mints a new deposit address.
 */
async function resolveCryptoRecipient(
  cfg: MppConfig,
  request: Request,
  amountUsd: string,
): Promise<string | null> {
  const authHeader = request.headers.get("authorization");
  const paymentHeader = authHeader ? Credential.extractPaymentScheme(authHeader) : null;
  if (paymentHeader) {
    try {
      const credential = Credential.fromRequest(request);
      if (credential.challenge.method === "tempo") {
        const declared = (credential.challenge.request as { recipient?: string }).recipient;
        if (declared && isCachedAddress(declared)) return declared;
        return null;
      }
      // Credential for another method (stripe) -- crypto lane not in play.
      return null;
    } catch {
      return null;
    }
  }
  try {
    return await createPayToAddress(cfg, amountUsd);
  } catch (err) {
    log.warn("MPP crypto deposit-address creation failed", { source: "mpp" }, err as Error);
    return null;
  }
}

// ── The HTTP payment gate ────────────────────────────────────────────────────

/**
 * Gate one HTTP request against a route price. Returns:
 *   paid          -- credential verified + charged; attach the receipt to
 *                    the final response.
 *   challenge     -- no/invalid credential; return the 402 Response (it
 *                    carries the WWW-Authenticate Payment headers).
 *   unconfigured  -- the route is priced but no payment lane is available.
 */
export async function gatePaidRequest(
  request: Request,
  price: RoutePrice,
): Promise<HttpPaymentGateResult> {
  const cfg = readConfig();
  const mppx = cfg ? getMppx(cfg) : null;
  if (!cfg || !mppx) {
    return {
      kind: "unconfigured",
      message: "This endpoint is paid, but the server has no payment method configured. " +
        "The operator must set MPP_SECRET_KEY plus STRIPE_SECRET_KEY + STRIPE_PROFILE_ID " +
        "(fiat) and/or MPP_CRYPTO_ENABLED=1 (USDC on Tempo).",
    };
  }

  // deno-lint-ignore no-explicit-any
  const handlers: Array<(req: Request) => Promise<any>> = [];

  if (price.cryptoUsd && cfg.cryptoEnabled && cfg.stripeSecretKey) {
    const recipient = await resolveCryptoRecipient(cfg, request, price.cryptoUsd);
    if (recipient) {
      handlers.push(mppx.tempo.charge({ amount: price.cryptoUsd, recipient }));
    }
  }
  if (price.cryptoUsd && x402Config(cfg)) {
    handlers.push(mppx.evm.charge({ amount: price.cryptoUsd }));
  }
  if (price.fiatUsd && cfg.stripeSecretKey && cfg.stripeProfileId) {
    handlers.push(
      mppx.stripe.charge({
        amount: price.fiatUsd,
        currency: "usd",
        decimals: 2,
        ...(price.description ? { description: price.description } : {}),
      }),
    );
  }

  if (handlers.length === 0) {
    return {
      kind: "unconfigured",
      message: "This endpoint is priced, but none of its price lanes match the server's " +
        "configured payment methods.",
    };
  }

  // Mppx.compose handles credential dispatch + merged multi-method 402s.
  const result = await Mppx.compose(...handlers)(request);
  if (result.status === 402) {
    return { kind: "challenge", response: result.challenge as Response };
  }
  return {
    kind: "paid",
    attachReceipt: (res: Response) => result.withReceipt(res) as Response,
  };
}

/** "$0.50 (card/wallet) or $0.05 (USDC)" -- for docs and error bodies. */
export function formatRoutePrice(price: RoutePrice): string {
  const parts: string[] = [];
  if (price.fiatUsd) parts.push(`$${price.fiatUsd} (card/wallet via Stripe)`);
  if (price.cryptoUsd) parts.push(`$${price.cryptoUsd} (USDC)`);
  return parts.join(" or ");
}
