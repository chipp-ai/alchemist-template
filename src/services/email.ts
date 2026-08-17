/**
 * Email Service
 *
 * Sends transactional emails via SMTP (nodemailer).
 * Falls back to console.log when SMTP is not configured (dev mode).
 */

import nodemailer from "nodemailer";
import { log } from "@/lib/logger.ts";
import { BRAND } from "@/config/brand.ts";
import { isDemoMode } from "@/config/demo-mode.ts";

// ── Config ──────────────────────────────────────────────────────────────────

const SMTP_HOST = Deno.env.get("SMTP_HOST");
const SMTP_PORT = parseInt(Deno.env.get("SMTP_PORT") ?? "465", 10);
const SMTP_USERNAME = Deno.env.get("SMTP_USERNAME");
const SMTP_PASSWORD = Deno.env.get("SMTP_PASSWORD");
// Branded "from" — `${BRAND.name} <${BRAND.fromEmail}>`. Read from
// the central brand module, NOT from env directly. See
// src/config/brand.ts for why.
const EMAIL_FROM = `${BRAND.fromName} <${BRAND.fromEmail}>`;

const isSmtpConfigured = !!(SMTP_HOST && SMTP_USERNAME && SMTP_PASSWORD);

// ── Transport ───────────────────────────────────────────────────────────────

let transport: nodemailer.Transporter | null = null;

if (isSmtpConfigured) {
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
  log.info("SMTP not configured -- emails will be logged to console", { source: "email" });
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

interface SendEmailOptions {
  to: string;
  subject: string;
  text: string;
  html?: string;
  /**
   * True for mail a user cannot complete their session without: the OTP login
   * code, an invite acceptance link. Such a send gets the verified-sender
   * fallback below, so a misconfigured branded sender degrades ordinary mail
   * without locking anyone out of their account.
   *
   * Leave unset for ordinary mail. The fallback trades brand fidelity for
   * deliverability, which is the right trade only when the alternative is a
   * user who cannot log in.
   */
  authCritical?: boolean;
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

  if (!transport) {
    // Dev fallback: log the email to console
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

// ── Invite Email ────────────────────────────────────────────────────────────

interface SendInviteEmailOptions {
  to: string;
  /** Inviter's display name; falls back to inviterEmail when null/empty. */
  inviterName: string | null;
  inviterEmail: string;
  organizationName: string;
  /** UI label for the role being offered ("Editor", "Admin", "Viewer"). */
  roleLabel: string;
  acceptUrl: string;
  expiresAt: Date;
}

/**
 * Send an invite email to a prospective team member.
 *
 * Falls back to console.log in dev (when SMTP isn't configured) — the
 * acceptUrl is logged so the agent can grab it during local testing
 * without a real mailbox.
 */
export async function sendInviteEmail(opts: SendInviteEmailOptions): Promise<void> {
  const appName = BRAND.name;
  const inviterDisplay = opts.inviterName?.trim() || opts.inviterEmail;

  // " on <App>" suffix — but only when the org name differs from the app
  // name. Many single-tenant apps name the org after the app, which
  // produced the awkward "invited you to Valor Victoria on Valor
  // Victoria". The branded "from" + accept page already convey the app,
  // so dropping the redundant suffix reads cleaner.
  const onApp = appName && appName.toLowerCase() !== opts.organizationName.toLowerCase()
    ? ` on ${appName}`
    : "";

  // "Expires in N days" copy. Floors so a 6.99-day-old invite reads "6 days".
  const msUntilExpiry = opts.expiresAt.getTime() - Date.now();
  const daysLeft = Math.max(1, Math.floor(msUntilExpiry / (1000 * 60 * 60 * 24)));

  await sendEmail({
    authCritical: true,
    to: opts.to,
    subject: `${inviterDisplay} invited you to ${opts.organizationName}${onApp}`,
    text: [
      `${inviterDisplay} invited you to join ${opts.organizationName}${onApp}`,
      `as ${opts.roleLabel}.`,
      "",
      "Accept the invite:",
      opts.acceptUrl,
      "",
      `This invite expires in ${daysLeft} day${daysLeft === 1 ? "" : "s"}.`,
      "",
      `If you don't recognize the sender, you can safely ignore this email.`,
    ].join("\n"),
    html: brandedEmailShell({
      previewText: `${inviterDisplay} invited you to join ${opts.organizationName}${onApp}`,
      bodyHtml: `
        <h1 style="margin:0 0 10px;font-family:${EMAIL_SERIF};font-size:31px;font-weight:600;line-height:1.1;color:${EMAIL_INK};">You're invited</h1>
        <p style="margin:0 0 26px;font-family:${EMAIL_SANS};font-size:15px;line-height:1.55;color:${EMAIL_MUTED};">
          <strong style="color:${EMAIL_INK};">${escapeHtml(inviterDisplay)}</strong> invited you to join
          <strong style="color:${EMAIL_INK};">${escapeHtml(opts.organizationName)}</strong>${escapeHtml(onApp)}
          as <strong style="color:${EMAIL_INK};">${escapeHtml(opts.roleLabel)}</strong>.
        </p>
        <table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 0 26px;">
          <tr><td style="background:${BRAND.primaryColor};border-radius:10px;">
            <a href="${escapeHtml(opts.acceptUrl)}" style="display:inline-block;padding:13px 26px;font-family:${EMAIL_SANS};font-size:15px;font-weight:700;color:#ffffff;text-decoration:none;">Accept invite</a>
          </td></tr>
        </table>
        <p style="margin:0 0 4px;font-family:${EMAIL_SANS};font-size:12px;color:${EMAIL_FAINT};">Or paste this link into your browser:</p>
        <p style="margin:0;font-family:${EMAIL_MONO};font-size:12px;line-height:1.5;word-break:break-all;"><a href="${escapeHtml(opts.acceptUrl)}" style="color:${BRAND.primaryColor};">${escapeHtml(opts.acceptUrl)}</a></p>
        <p style="margin:26px 0 0;font-family:${EMAIL_SANS};font-size:13px;line-height:1.5;color:${EMAIL_FAINT};">
          This invite expires in ${daysLeft} day${daysLeft === 1 ? "" : "s"}.
          If you don't recognize the sender, you can safely ignore this email.
        </p>
      `,
    }),
  });
}

/** Minimal HTML escape for email interpolation. Only safe for
 *  text nodes + attribute values, which is all we use it for here. */
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// ── Branded email shell ───────────────────────────────────────────────────
// Table-based, inline-styled, webfont-free (email clients strip <style> and
// block @font-face) — the brand pop is the primary color (top rule, accents)
// plus the logo / serif wordmark. Warm-neutral ink + canvas read well under
// ANY brand color, so a customer with only a primary set still gets a
// polished, on-brand email. The serif stack degrades to Georgia where
// Cormorant can't load (i.e. every mail client) — still editorial.
const EMAIL_SERIF = "'Cormorant Garamond', Georgia, 'Times New Roman', serif";
const EMAIL_SANS =
  "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";
const EMAIL_MONO = "'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";
const EMAIL_INK = "#1a1712";
const EMAIL_MUTED = "#6b6457";
const EMAIL_FAINT = "#9a917f";
const EMAIL_PAGE_BG = "#f4f2ec";
const EMAIL_BORDER = "#e7e1d4";

function brandedEmailShell(opts: { previewText?: string; bodyHtml: string }): string {
  const primary = BRAND.primaryColor;
  // Serif wordmark in the brand color — not the logo image. Reliable across
  // every mail client (no blocked-image / wrong-variant / low-contrast
  // surprises: a brand's logo may be a light-on-dark mark that vanishes on
  // the white card), high-contrast, and unmistakably on-brand.
  const header =
    `<span style="font-family:${EMAIL_SERIF};font-size:27px;font-weight:700;letter-spacing:-0.01em;color:${primary};">${escapeHtml(BRAND.name)}</span>`;
  const preview = opts.previewText
    ? `<div style="display:none;max-height:0;overflow:hidden;mso-hide:all;opacity:0;color:transparent;">${escapeHtml(opts.previewText)}</div>`
    : "";
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8" /><meta name="viewport" content="width=device-width,initial-scale=1" /></head>
<body style="margin:0;padding:0;background:${EMAIL_PAGE_BG};">
  ${preview}
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${EMAIL_PAGE_BG};padding:36px 12px;">
    <tr><td align="center">
      <table role="presentation" width="480" cellpadding="0" cellspacing="0" style="max-width:480px;width:100%;background:#ffffff;border:1px solid ${EMAIL_BORDER};border-radius:14px;overflow:hidden;">
        <tr><td style="height:5px;line-height:0;font-size:0;background:${primary};">&nbsp;</td></tr>
        <tr><td style="padding:32px 38px 0;">${header}</td></tr>
        <tr><td style="padding:22px 38px 36px;">${opts.bodyHtml}</td></tr>
      </table>
      <table role="presentation" width="480" cellpadding="0" cellspacing="0" style="max-width:480px;width:100%;">
        <tr><td style="padding:18px 38px;font-family:${EMAIL_SANS};font-size:12px;line-height:1.5;color:${EMAIL_FAINT};">
          ${escapeHtml(BRAND.name)} &middot; This is an automated message, please don't reply.
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;
}

// ── OTP Email ───────────────────────────────────────────────────────────────

export async function sendOtpEmail(to: string, otpCode: string): Promise<void> {
  const appName = BRAND.name;

  await sendEmail({
    authCritical: true,
    to,
    subject: `${otpCode} is your ${appName} verification code`,
    text: [
      `Your verification code is: ${otpCode}`,
      "",
      "This code expires in 10 minutes.",
      "",
      `If you didn't request this code, you can safely ignore this email.`,
    ].join("\n"),
    html: brandedEmailShell({
      previewText: `${otpCode} — your ${appName} verification code (expires in 10 minutes)`,
      bodyHtml: `
        <h1 style="margin:0 0 10px;font-family:${EMAIL_SERIF};font-size:31px;font-weight:600;line-height:1.1;color:${EMAIL_INK};">Verification code</h1>
        <p style="margin:0 0 26px;font-family:${EMAIL_SANS};font-size:15px;line-height:1.5;color:${EMAIL_MUTED};">Enter this code to sign in to ${escapeHtml(appName)}.</p>
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
          <tr><td align="center" style="background:#faf8f3;border:2px solid ${BRAND.primaryColor};border-radius:12px;padding:24px 16px;">
            <span style="font-family:${EMAIL_MONO};font-size:40px;font-weight:700;letter-spacing:14px;color:${EMAIL_INK};padding-left:14px;">${otpCode}</span>
          </td></tr>
        </table>
        <p style="margin:26px 0 0;font-family:${EMAIL_SANS};font-size:13px;line-height:1.5;color:${EMAIL_FAINT};">This code expires in 10 minutes. If you didn't request it, you can safely ignore this email.</p>
      `,
    }),
  });
}
