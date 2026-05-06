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
 * Anything user-visible that should be customer-brandable. Colors
 * are NOT here — those are dynamic via `/brand.json` + the
 * brand-loader.js running in the SPA, because they may change
 * between page loads (brand chat live-updates). The values in
 * this module are read at boot and assumed stable for the pod's
 * lifetime — they end up in transactional emails (built before the
 * SPA exists for a recipient) and in the static HTML title (which
 * is set on the document at request time by the SSR/SPA).
 *
 * # Why a module, not just env reads at the call site
 *
 * Scattered `Deno.env.get("APP_NAME") ?? "Alchemist"` calls are
 * exactly how the leak escaped review. Centralizing forces a single
 * audit point: every "where does the product name come from?"
 * answer points HERE, no matter which file the question started in.
 */

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
}

export const BRAND: Brand = Object.freeze({
  name: Deno.env.get("APP_NAME") ?? "Your App",
  fromEmail: Deno.env.get("EMAIL_FROM") ?? "noreply@example.com",
  fromName: Deno.env.get("APP_NAME") ?? "Your App",
});
