/**
 * Email transport -- the ONE place an outbound message leaves this app.
 *
 * Everything that sends mail funnels through `sendEmail()`, in this
 * fixed order:
 *
 *   1. DEMO_MODE            public demo pods never send, at all.
 *   2. Communications gate  org master toggle + per-user preference.
 *                           SKIPPED for auth-critical mail and for the
 *                           admin test send (see communications.service.ts
 *                           for why that ordering is load-bearing).
 *   3. Dev mailbox capture  in-memory ring buffer, so a sandbox / test can
 *                           observe the send (see email-mailbox.ts).
 *   4. SMTP, or the console fallback when SMTP is unconfigured.
 *
 * Composing a message is NOT this module's job. Use the kind registry in
 * `email-kinds.ts` so the branded shell is built once; call `sendEmail`
 * directly only for a genuinely one-off message.
 */

import nodemailer from "nodemailer";
import { log } from "@/lib/logger.ts";
import { BRAND } from "@/config/brand.ts";
import { isDemoMode } from "@/config/demo-mode.ts";
import { devRoutesEnabled } from "@/lib/dev-mode.ts";
import { captureEmail } from "@/services/email-mailbox.ts";
import { checkCommunicationsSuppression } from "@/services/communications.service.ts";

// ── Config ──────────────────────────────────────────────────────────────────

const SMTP_HOST = Deno.env.get("SMTP_HOST");
const SMTP_PORT = parseInt(Deno.env.get("SMTP_PORT") ?? "465", 10);
const SMTP_USERNAME = Deno.env.get("SMTP_USERNAME");
const SMTP_PASSWORD = Deno.env.get("SMTP_PASSWORD");
// Branded "from" -- `${BRAND.name} <${BRAND.fromEmail}>`. Read from
// the central brand module, NOT from env directly. See
// src/config/brand.ts for why.
const EMAIL_FROM = `${BRAND.fromName} <${BRAND.fromEmail}>`;

const smtpConfigured = !!(SMTP_HOST && SMTP_USERNAME && SMTP_PASSWORD);

/** True when this deployment has real SMTP credentials. */
export function isSmtpConfigured(): boolean {
  return smtpConfigured;
}

/**
 * Is the dev mailbox capturing?
 *
 * ON when there is no SMTP transport (nothing can be delivered, so the
 * buffer is the only record), or when the fail-closed dev surface is
 * enabled, or under the test runner. A production pod with real SMTP and
 * no ALCHEMIST_DEV_ROUTES captures nothing, and the read routes 404
 * there anyway -- two independent reasons the buffer can never leak
 * customer mail.
 *
 * Evaluated per call, never cached, so a test can flip the env.
 */
export function mailboxCaptureEnabled(): boolean {
  if (!smtpConfigured) return true;
  if (devRoutesEnabled()) return true;
  return safeEnv("NODE_ENV") === "test";
}

function safeEnv(key: string): string | undefined {
  try {
    return Deno.env.get(key);
  } catch {
    return undefined;
  }
}

// ── Transport ───────────────────────────────────────────────────────────────

let transport: nodemailer.Transporter | null = null;

if (smtpConfigured) {
  transport = nodemailer.createTransport({
    host: SMTP_HOST,
    port: SMTP_PORT,
    secure: SMTP_PORT === 465,
    auth: {
      user: SMTP_USERNAME,
      pass: SMTP_PASSWORD,
    },
  });
  log.info("SMTP transport configured", { source: "email", host: SMTP_HOST });
} else {
  log.info("SMTP not configured -- emails are captured to the dev mailbox", { source: "email" });
}

// ── Verified-sender fallback (AUTH_CRITICAL_VERIFIED_SENDER_FALLBACK) ───────────────────

/**
 * The platform's provider-VERIFIED sender, injected into every customer pod
 * by the shared `alchemist-customer-platform-creds` secret. Never overridable
 * by a project credential -- it is on the platform-owned env var list, so a
 * per-project value can never shadow it.
 *
 * This is the address auth-critical mail falls back to when the configured
 * sender is rejected. Empty when a deployment genuinely has no platform
 * sender (local dev), in which case the fallback is skipped and the original
 * error propagates unchanged.
 */
const PLATFORM_EMAIL_FROM = Deno.env.get("PLATFORM_EMAIL_FROM") ?? "";

/**
 * Matches the mail provider's permanent refusal to send as an unverified
 * sender domain. SMTP2GO's wording, which is what every platform-SMTP
 * deployment sees:
 *
 *   550-From header sender domain not verified (example.com)
 *
 * Deliberately narrow. A broad "any 5xx" match would retry sends that failed
 * for reasons the fallback cannot fix (a bad recipient, a blocked message),
 * turning one honest failure into two.
 */
const UNVERIFIED_SENDER_RE = /sender domain not verified|sender.{0,40}not verified/i;

function isUnverifiedSenderRejection(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err ?? "");
  return UNVERIFIED_SENDER_RE.test(message);
}

// ── Public API ──────────────────────────────────────────────────────────────

export interface SendEmailOptions {
  to: string;
  subject: string;
  text: string;
  html?: string;
  /**
   * True for mail a user cannot complete their session without: the OTP login
   * code, an invite acceptance link, a portal access link. Such a send gets
   * the verified-sender fallback below AND skips the communications gate, so
   * neither a misconfigured branded sender nor a muted workspace can lock
   * anyone out of their account.
   *
   * Leave unset for ordinary mail. The fallback trades brand fidelity for
   * deliverability, which is the right trade only when the alternative is a
   * user who cannot log in.
   */
  authCritical?: boolean;
  /**
   * Registered kind name, recorded on the captured entry so a test can
   * assert `lastCapturedEmail({ kind: "invite" })`. Set automatically by
   * `sendEmailKind`; leave unset for a one-off send.
   */
  kind?: string;
  /**
   * Org whose master communications toggle applies. Omit and the gate
   * falls back to the recipient's own org.
   */
  organizationId?: string | null;
  /**
   * Skip the communications gate for a message that is not auth-critical.
   * The ONLY intended caller is `sendTestEmail()`: an admin proving
   * delivery works must not be blocked by the very toggle they are
   * debugging. Do not reach for this to "make sure it goes out".
   */
  bypassSuppression?: boolean;
}

export async function sendEmail(opts: SendEmailOptions): Promise<void> {
  // DEMO_MODE guard: every message this app can send (OTP codes, invite
  // links, ...) is ultimately routed through this function, and every one
  // of those recipients is either visitor-entered or a seeded demo
  // address we don't want spammed on a nightly re-seed loop. Per the
  // shared DEMO_MODE contract, no real outbound email is ever sent while
  // a deployment is a public demo -- suppress unconditionally rather than
  // trying to distinguish "visitor" from "seeded" addresses, which would
  // require a heuristic on user-entered data.
  if (isDemoMode()) {
    log.info("Demo mode: suppressing outbound email", {
      source: "email",
      to: opts.to,
      subject: opts.subject,
    });
    console.log(`[demo-mode] Email suppressed (would have sent to ${opts.to}): ${opts.subject}`);
    return;
  }

  // Communications gate. Auth-critical mail and the admin test send never
  // reach it -- see communications.service.ts.
  if (!opts.authCritical && !opts.bypassSuppression) {
    const gate = await checkCommunicationsSuppression({
      to: opts.to,
      organizationId: opts.organizationId ?? null,
    });
    if (gate.suppressed) {
      // info, not warn: a muted workspace is working as designed. It is
      // queryable when someone asks "why did the digest not arrive", and
      // it never pages.
      log.info("Communications gate: suppressing outbound email", {
        source: "email",
        feature: "communications-gate",
        to: opts.to,
        kind: opts.kind ?? null,
        reason: gate.reason,
      });
      return;
    }
  }

  // Capture BEFORE delivery, and only after every suppression check, so
  // the mailbox is exactly "what this app decided to send". A suppressed
  // message is absent from it, which is what a gate test asserts on.
  if (mailboxCaptureEnabled()) {
    captureEmail({
      kind: opts.kind ?? null,
      to: opts.to,
      from: EMAIL_FROM,
      subject: opts.subject,
      text: opts.text,
      html: opts.html ?? null,
    });
  }

  if (!transport) {
    // Dev fallback: log the email to console. Kept alongside the mailbox
    // because a human tailing `deno task dev` still wants to see the OTP
    // code scroll past without opening a second tool.
    console.log(`[email] To: ${opts.to}`);
    console.log(`[email] Subject: ${opts.subject}`);
    console.log(`[email] Body: ${opts.text}`);
    return;
  }

  try {
    await transport.sendMail({
      from: EMAIL_FROM,
      to: opts.to,
      subject: opts.subject,
      text: opts.text,
      html: opts.html,
    });
    log.info("Email sent", { source: "email", to: opts.to, subject: opts.subject });
  } catch (err) {
    // AUTH_CRITICAL_VERIFIED_SENDER_FALLBACK
    //
    // The configured sender was refused as unverified. For ORDINARY mail that
    // is a real failure and the caller should hear about it. For AUTH-CRITICAL
    // mail it is a lockout: the user cannot receive the code that is the only
    // way into their account, and no amount of retrying the same From will
    // ever work. So retry ONCE from the platform's verified sender, keeping
    // the brand as the display name and routing replies back to the
    // configured address.
    //
    // Ordered deliberately: this is a fallback on the failure path, never a
    // pre-emptive rewrite of the sender. A correctly configured branded sender
    // is used as-is and never touches this branch.
    const canFallBack = opts.authCritical === true &&
      isUnverifiedSenderRejection(err) &&
      !!PLATFORM_EMAIL_FROM &&
      BRAND.fromEmail !== PLATFORM_EMAIL_FROM;

    if (canFallBack) {
      // warn, not error: this is a handled, operator-actionable configuration
      // problem that we just recovered from, and it repeats on every send
      // until the domain is verified. An error here would page on a condition
      // already contained.
      log.warn(
        "Sender domain not verified -- retrying auth-critical email from the platform sender",
        {
          source: "email",
          feature: "verified-sender-fallback",
          to: opts.to,
          configuredFrom: BRAND.fromEmail,
        },
        err as Error,
      );
      try {
        await transport.sendMail({
          from: `${BRAND.fromName} <${PLATFORM_EMAIL_FROM}>`,
          // Pin the SMTP envelope too. A provider checks the envelope sender
          // as well as the header, so leaving it to nodemailer's default
          // would reproduce the same rejection.
          envelope: { from: PLATFORM_EMAIL_FROM, to: opts.to },
          replyTo: BRAND.fromEmail,
          to: opts.to,
          subject: opts.subject,
          text: opts.text,
          html: opts.html,
        });
        log.info("Email sent", {
          source: "email",
          feature: "verified-sender-fallback",
          to: opts.to,
          subject: opts.subject,
        });
        return;
      } catch (fallbackErr) {
        // The fallback failed too. Report the ORIGINAL error below -- it names
        // the configured sender, which is the thing an operator has to fix.
        log.error(
          "Verified-sender fallback also failed",
          { source: "email", feature: "verified-sender-fallback", to: opts.to },
          fallbackErr as Error,
        );
      }
    }

    log.error("Failed to send email", { source: "email", to: opts.to }, err as Error);
    throw err;
  }
}
