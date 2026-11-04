/**
 * Bulk sender policy: a newsletter never goes out from the shared platform
 * sender.
 *
 * Why (2026-11-04): an app built from this template mailed a 12,000-contact
 * imported list from `noreply@chipp.ai`, the sender every app on the
 * platform shares. One week: 6 spam complaints and 1,044 hard bounces. A
 * mailbox provider judges a sender by its domain, so one app's bad list
 * damages delivery for every other app, sign-in codes included.
 *
 * The rule: a campaign (newsletter, announcement, any send to a mailing
 * list) needs a sending domain the customer owns and has verified.
 * Transactional mail (sign-in codes, invites, receipts, reminders) is not
 * affected and keeps working on the shared sender.
 *
 * How a customer gets one: the platform's own sending-domain feature. In
 * the Software Factory, the project's Settings, Emails panel takes a
 * domain, shows the DNS records, and verifies them with the provider. Once
 * verified, the platform redeploys the app with `EMAIL_FROM` set to an
 * address at that domain. The pod has no separate "verified" flag: the
 * platform only ever sets `EMAIL_FROM` to a customer domain AFTER the
 * provider confirmed it, so "EMAIL_FROM is not on a shared domain" is the
 * signal. A self-supplied SMTP credential that sets its own `EMAIL_FROM`
 * counts too: that provider verifies its own domain.
 *
 * Dev: with no SMTP configured nothing can leave the pod (mail lands in the
 * dev mailbox), so the policy allows campaigns there and says so. Agents
 * can then verify a campaign flow end to end locally.
 */

import { BRAND } from "@/config/brand.ts";
import { getEnv } from "@/lib/env.ts";
import { isSmtpConfigured } from "@/services/email-transport.ts";
import { isReservedRecipientAddress } from "@/services/email-transport.ts";

/**
 * Domains that are shared by every app on the platform and can never be a
 * customer's own sending domain. The platform sender's domain
 * (`PLATFORM_EMAIL_FROM`) and `ALCHEMIST_DOMAIN` are added at check time.
 */
export const SHARED_SENDER_DOMAINS: readonly string[] = Object.freeze([
  "chipp.ai",
  "adaas.dev",
]);

export type BulkSenderCode =
  /** EMAIL_FROM is on a domain the customer owns. Campaigns may send. */
  | "customer_domain"
  /** No SMTP: mail only reaches the dev mailbox. Campaigns may "send". */
  | "dev_capture"
  /** EMAIL_FROM is the shared platform sender (or another shared domain). */
  | "shared_platform_sender"
  /** EMAIL_FROM is unset or a placeholder (noreply@example.com). */
  | "no_sender";

export interface BulkSenderStatus {
  allowed: boolean;
  code: BulkSenderCode;
  fromEmail: string;
  domain: string | null;
  /** One paragraph for the builder: what is wrong and how to fix it. */
  message: string;
}

export interface BulkSenderInputs {
  fromEmail: string;
  platformEmailFrom: string;
  smtpConfigured: boolean;
  /** ALCHEMIST_DOMAIN, when the platform sets one. */
  platformDomain?: string;
}

/**
 * The words a builder sees when a campaign is blocked. Exported so the
 * routes, the runner and the tests all say the same thing.
 */
export const VERIFY_DOMAIN_STEPS =
  "To fix it, verify a sending domain you own: in the Software Factory, open this project's " +
  "Settings, go to Emails, enter a domain you control (a subdomain such as news.yourbrand.com " +
  "works well), add the DNS records it shows at your DNS provider, then click Verify. When the " +
  "domain is verified the app redeploys and sends from it, and campaigns can go out. Sign-in " +
  "codes, invites, receipts and reminders keep working in the meantime.";

function domainOf(address: string): string | null {
  const at = address.lastIndexOf("@");
  if (at < 0) return null;
  const domain = address.slice(at + 1).trim().toLowerCase().replace(/[>\s.]+$/, "");
  return domain || null;
}

function isUnder(domain: string, zone: string): boolean {
  return domain === zone || domain.endsWith(`.${zone}`);
}

function readEnv(key: string): string {
  try {
    return getEnv(key) ?? "";
  } catch {
    return "";
  }
}

/** Pure: decide from explicit inputs. Tests call this directly. */
export function evaluateBulkSender(input: BulkSenderInputs): BulkSenderStatus {
  const fromEmail = input.fromEmail.trim().toLowerCase();
  const domain = domainOf(fromEmail);

  if (!input.smtpConfigured) {
    return {
      allowed: true,
      code: "dev_capture",
      fromEmail,
      domain,
      message:
        "SMTP is not configured here, so campaign mail only reaches the dev mailbox. In production " +
        "a campaign needs a verified sending domain of your own.",
    };
  }

  if (!domain || isReservedRecipientAddress(fromEmail)) {
    return {
      allowed: false,
      code: "no_sender",
      fromEmail,
      domain,
      message: `This app has no sending address of its own (EMAIL_FROM is ${
        fromEmail || "not set"
      }), so a campaign cannot go out. ${VERIFY_DOMAIN_STEPS}`,
    };
  }

  const shared = new Set(SHARED_SENDER_DOMAINS);
  const platformDomain = domainOf(input.platformEmailFrom);
  if (platformDomain) shared.add(platformDomain);
  if (input.platformDomain) shared.add(input.platformDomain.trim().toLowerCase());
  const platformAddress = input.platformEmailFrom.trim().toLowerCase();

  if (fromEmail === platformAddress || [...shared].some((zone) => isUnder(domain, zone))) {
    return {
      allowed: false,
      code: "shared_platform_sender",
      fromEmail,
      domain,
      message:
        `Campaigns cannot be sent from ${fromEmail}. That address is shared by every app on ` +
        "the platform, and bulk mail from a shared address puts all of them at risk: spam " +
        "complaints and bounces from one list get the shared sender blocked for everyone. " +
        VERIFY_DOMAIN_STEPS,
    };
  }

  return {
    allowed: true,
    code: "customer_domain",
    fromEmail,
    domain,
    message: `Campaigns send from ${fromEmail}, on your own domain ${domain}.`,
  };
}

/** Test seam: replace to pin the sender without touching the frozen BRAND. */
export const _internalsForTest = {
  inputs: (): BulkSenderInputs => ({
    fromEmail: BRAND.fromEmail,
    platformEmailFrom: readEnv("PLATFORM_EMAIL_FROM"),
    smtpConfigured: isSmtpConfigured(),
    platformDomain: readEnv("ALCHEMIST_DOMAIN") || undefined,
  }),
};

/** This deployment's status. Evaluated per call: cheap, and env can be overridden in tests. */
export function bulkSenderStatus(): BulkSenderStatus {
  return evaluateBulkSender(_internalsForTest.inputs());
}
