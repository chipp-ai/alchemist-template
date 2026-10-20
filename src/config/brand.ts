/**
 * Brand — single source of truth for the customer-facing product
 * identity.
 *
 * Every place that surfaces the product name to end users (email
 * subject lines + bodies, HTML <title>, OG meta tags, etc.) MUST
 * read from this module. Hardcoded "Alchemist" or any other
 * platform-side branding is a leak and a bug — alchemist-template
 * is deployed PER CUSTOMER and the customer's app must look like
 * their app, not like the platform that builds it.
 *
 * # The contract
 *
 * Every field is overridable by an env var the alchemist-ai
 * platform sets on the customer pod at provisioning time, derived
 * from the project's `brand_config` JSONB. When the env var is
 * missing (e.g. `deno task dev` locally without a platform-set
 * env), the fallback is intentionally generic ("Your App",
 * `noreply@example.com`) — never "Alchemist", never an adaas.dev
 * domain. This ensures a customer who happens to bypass the
 * platform's env injection STILL doesn't leak Alchemist branding.
 *
 * # What goes in here
 *
 * Anything user-visible that should be customer-brandable. The SPA's
 * look comes from web/src/design/design.json (the only source of the
 * look); the email colors below follow it too. The values in this
 * module are read at boot and assumed stable for the pod's lifetime — they end up in transactional emails (built before the
 * SPA exists for a recipient) and in the static HTML title (which
 * is set on the document at request time by the SSR/SPA).
 *
 * # Why a module, not just env reads at the call site
 *
 * Scattered `getEnv("APP_NAME") ?? "Alchemist"` calls are
 * exactly how the leak escaped review. Centralizing forces a single
 * audit point: every "where does the product name come from?"
 * answer points HERE, no matter which file the question started in.
 */

import { getEnv } from "@/lib/env.ts";

const HEX_RE = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

/**
 * Email colors from web/src/design/design.json, read once at boot. Empty
 * when the file is missing or unreadable (the image may not carry web/src),
 * so the env values or the neutral defaults stand. Never throws.
 */
export function designEmailColorsSync(
  path: string = new URL("../../web/src/design/design.json", import.meta.url).pathname,
): { primary?: string; accent?: string; neutral?: string } {
  try {
    const parsed = JSON.parse(Deno.readTextFileSync(path)) as {
      colors?: { primary?: unknown; accent?: unknown; background?: unknown };
    };
    const c = parsed?.colors ?? {};
    const hex = (v: unknown) => (typeof v === "string" && HEX_RE.test(v) ? v : undefined);
    return { primary: hex(c.primary), accent: hex(c.accent), neutral: hex(c.background) };
  } catch {
    return {};
  }
}

const DESIGN_EMAIL = designEmailColorsSync();

export interface Brand {
  /**
   * The user-facing product name. Appears in email subject lines,
   * email bodies, and HTML <title>. Sourced from
   * `platform.projects.brand_config.productName` via the
   * APP_NAME env var the platform injects at deploy time.
   *
   * Fallback: "Your App" — neutral, NEVER "Alchemist".
   */
  readonly name: string;

  /**
   * The "from" address for transactional emails. Sourced from
   * EMAIL_FROM (set on the customer pod by the platform's
   * shared `alchemist-customer-platform-creds` secret bag).
   *
   * Fallback: "noreply@example.com" — invalid by design, so a
   * misconfigured pod fails loudly instead of leaking
   * "noreply@alchemist.ai" into customers' inboxes.
   */
  readonly fromEmail: string;

  /**
   * Optional display name for the email "from" header. When unset,
   * just the address is used. Conventionally `${name} <${fromEmail}>`.
   */
  readonly fromName: string;

  /**
   * Brand palette + logo for SERVER-SIDE rendered surfaces, chiefly
   * transactional emails (OTP, invites), which are built before any SPA
   * exists for the recipient. Order: the BRAND_* env the platform injects
   * (for a project whose look is in code it reads them from design.json
   * at the deployed sha), then web/src/design/design.json read at boot,
   * then the neutral defaults below.
   *
   * Fallbacks are the template's neutral defaults (NEVER a specific
   * customer's colors) so an un-branded pod still renders a clean,
   * generic email rather than leaking another tenant's palette.
   */
  readonly primaryColor: string;
  readonly accentColor: string;
  readonly neutralColor: string;
  /** Absolute https URL to the light-background logo, or "" when unset. */
  readonly logoUrl: string;
}

export const BRAND: Brand = Object.freeze({
  name: getEnv("APP_NAME") ?? "Your App",
  fromEmail: getEnv("EMAIL_FROM") ?? "noreply@example.com",
  fromName: getEnv("APP_NAME") ?? "Your App",
  primaryColor: getEnv("BRAND_PRIMARY") ?? DESIGN_EMAIL.primary ?? "#4f46e5",
  accentColor: getEnv("BRAND_ACCENT") ?? DESIGN_EMAIL.accent ?? "#0ea5e9",
  neutralColor: getEnv("BRAND_NEUTRAL") ?? DESIGN_EMAIL.neutral ?? "#1f2937",
  logoUrl: getEnv("BRAND_LOGO_URL") ?? "",
});
