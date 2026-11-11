/**
 * Platform auth mail: the ONLY mail this app may send through Chipp's
 * shared mail service.
 *
 * Chipp sends sign-in mail for every hosted app, free: a sign-in code, a
 * sign-in link, an email verification, a password reset. The app sends an
 * INTENT, never a message:
 *
 *   POST ${CHIPP_MAIL_URL}/api/internal/project-mail/auth
 *   { kind: "otp_code" | "magic_link" | "email_verification" | "password_reset",
 *     to: "<one address>", code?: "<4-12 letters or digits>",
 *     link?: "https://<one of this app's own domains>/...",
 *     expiresInMinutes? }
 *
 * Chipp renders the email from its own fixed template, from the app's
 * verified sending domain when it has one. One recipient per request, limits
 * per recipient and per app, and a daily cap. Anything else (reminders,
 * digests, newsletters, notifications, receipts) is NOT auth mail and needs
 * the app's own provider key: see docs/agent-guidance/email-transactional.md.
 *
 * The pod gets CHIPP_MAIL_URL, CHIPP_MAIL_TOKEN, PROJECT_ID and CHIPP_ORG_ID
 * from the platform. Without all four (local dev, tests) this module reports
 * `unavailable` and the caller falls back to SMTP or the dev mailbox.
 */

import { log } from "@/lib/logger.ts";
import { getEnv } from "@/lib/env.ts";

export type PlatformAuthMailKind =
  | "otp_code"
  | "magic_link"
  | "email_verification"
  | "password_reset";

export interface PlatformAuthIntent {
  kind: PlatformAuthMailKind;
  /** A 4-12 character letters-or-digits code. Exactly one of code or link. */
  code?: string;
  /** An https link on one of this app's own domains. */
  link?: string;
  /** Minutes until the code or link stops working; shown in the email. */
  expiresInMinutes?: number;
}

export type PlatformAuthMailResult =
  /** Chipp accepted the message. */
  | { status: "sent" }
  /**
   * Chipp's auth mail service is not reachable from here (not configured,
   * not deployed yet, a network failure, or a retryable platform error).
   * The caller may use another transport.
   */
  | { status: "unavailable"; reason: string };

/** Thrown when Chipp refused the intent itself (bad shape, auth, a limit). */
export class PlatformAuthMailRefusedError extends Error {
  constructor(readonly httpStatus: number, message: string) {
    super(message);
    this.name = "PlatformAuthMailRefusedError";
  }
}

interface PlatformMailConfig {
  url: string;
  token: string;
  projectId: string;
  orgId: string;
}

function config(): PlatformMailConfig | null {
  const url = getEnv("CHIPP_MAIL_URL")?.trim();
  const token = getEnv("CHIPP_MAIL_TOKEN")?.trim();
  const projectId = getEnv("PROJECT_ID")?.trim();
  const orgId = getEnv("CHIPP_ORG_ID")?.trim();
  if (!url || !token || !projectId || !orgId) return null;
  return { url: url.replace(/\/+$/, ""), token, projectId, orgId };
}

/** True when this pod can reach Chipp's auth mail service. */
export function platformAuthMailConfigured(): boolean {
  return config() !== null;
}

/** Test seam. */
export const _platformAuthMailInternals = {
  fetch: (input: string, init: RequestInit) => fetch(input, init),
};

/**
 * Send one auth intent. Resolves `sent` or `unavailable`; throws
 * PlatformAuthMailRefusedError when Chipp refused the intent (400, 401, 403,
 * 429, or a non-retryable 424). A refusal is final: falling back to
 * another transport would bypass the limits.
 */
export async function sendPlatformAuthMail(opts: {
  to: string;
  intent: PlatformAuthIntent;
}): Promise<PlatformAuthMailResult> {
  const cfg = config();
  if (!cfg) return { status: "unavailable", reason: "not_configured" };

  const body: Record<string, unknown> = { kind: opts.intent.kind, to: opts.to };
  if (opts.intent.code) body.code = opts.intent.code;
  if (opts.intent.link) body.link = opts.intent.link;
  if (opts.intent.expiresInMinutes) body.expiresInMinutes = opts.intent.expiresInMinutes;

  let res: Response;
  try {
    res = await _platformAuthMailInternals.fetch(`${cfg.url}/api/internal/project-mail/auth`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-chipp-mail-auth": cfg.token,
        "x-chipp-mail-project": cfg.projectId,
        "x-chipp-mail-org": cfg.orgId,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
  } catch (err) {
    log.warn("Platform auth mail unreachable", {
      source: "email",
      feature: "platform-auth-mail",
      kind: opts.intent.kind,
    }, err as Error);
    return { status: "unavailable", reason: "network" };
  }

  const payload = await res.json().catch(() => ({})) as { error?: string; retryable?: boolean };
  if (res.ok) {
    log.info("Platform auth mail sent", { source: "email", feature: "platform-auth-mail", kind: opts.intent.kind });
    return { status: "sent" };
  }
  // 404: the platform has not deployed the auth route yet. 5xx: an outage.
  // A retryable 424: the provider did not take it this time. 422: the link
  // is not on one of this app's hosts as Chipp knows them (APP_URL drift), a
  // configuration problem the app's own transport can still cover. A 429 is
  // never here: falling back would bypass the limits.
  if (
    res.status === 404 || res.status === 422 || res.status >= 500 ||
    (res.status === 424 && payload.retryable === true)
  ) {
    log.warn("Platform auth mail unavailable", {
      source: "email",
      feature: "platform-auth-mail",
      kind: opts.intent.kind,
      status: res.status,
    });
    return { status: "unavailable", reason: `http_${res.status}` };
  }
  throw new PlatformAuthMailRefusedError(
    res.status,
    `Chipp refused the ${opts.intent.kind} email (${res.status}): ${payload.error ?? "refused"}`,
  );
}
