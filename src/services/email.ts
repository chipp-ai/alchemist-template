/**
 * Email Service
 *
 * Sends transactional emails via SMTP (nodemailer).
 * Falls back to console.log when SMTP is not configured (dev mode).
 */

import nodemailer from "nodemailer";
import { log } from "@/lib/logger.ts";
import { BRAND } from "@/config/brand.ts";

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

// ── Public API ──────────────────────────────────────────────────────────────

interface SendEmailOptions {
  to: string;
  subject: string;
  text: string;
  html?: string;
}

export async function sendEmail(opts: SendEmailOptions): Promise<void> {
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
    html: `
      <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 480px; margin: 0 auto; padding: 40px 20px;">
        <h2 style="font-size: 20px; font-weight: 600; margin-bottom: 8px;">You're invited</h2>
        <p style="color: #374151; font-size: 14px; margin-bottom: 24px;">
          <strong>${escapeHtml(inviterDisplay)}</strong> invited you to join
          <strong>${escapeHtml(opts.organizationName)}</strong>${escapeHtml(onApp)}
          as <strong>${escapeHtml(opts.roleLabel)}</strong>.
        </p>
        <p style="margin-bottom: 24px;">
          <a href="${opts.acceptUrl}" style="display: inline-block; background: #111827; color: #ffffff; text-decoration: none; padding: 12px 20px; border-radius: 8px; font-weight: 600; font-size: 14px;">Accept invite</a>
        </p>
        <p style="color: #6b7280; font-size: 12px; word-break: break-all;">
          Or paste this link into your browser:<br>
          <a href="${opts.acceptUrl}" style="color: #2563eb;">${opts.acceptUrl}</a>
        </p>
        <p style="color: #9ca3af; font-size: 12px; margin-top: 24px;">
          This invite expires in ${daysLeft} day${daysLeft === 1 ? "" : "s"}.
          If you don't recognize the sender, you can safely ignore this email.
        </p>
      </div>
    `,
  });
}

/** Minimal HTML escape for invite email interpolation. Only safe for
 *  text nodes + attribute values, which is all we use it for here. */
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// ── OTP Email ───────────────────────────────────────────────────────────────

export async function sendOtpEmail(to: string, otpCode: string): Promise<void> {
  const appName = BRAND.name;

  await sendEmail({
    to,
    subject: `${otpCode} is your ${appName} verification code`,
    text: [
      `Your verification code is: ${otpCode}`,
      "",
      "This code expires in 10 minutes.",
      "",
      `If you didn't request this code, you can safely ignore this email.`,
    ].join("\n"),
    html: `
      <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 480px; margin: 0 auto; padding: 40px 20px;">
        <h2 style="font-size: 20px; font-weight: 600; margin-bottom: 8px;">Verification code</h2>
        <p style="color: #6b7280; font-size: 14px; margin-bottom: 24px;">Enter this code to sign in to ${appName}.</p>
        <div style="background: #f3f4f6; border-radius: 8px; padding: 20px; text-align: center; margin-bottom: 24px;">
          <span style="font-family: monospace; font-size: 32px; letter-spacing: 8px; font-weight: 700;">${otpCode}</span>
        </div>
        <p style="color: #9ca3af; font-size: 12px;">This code expires in 10 minutes. If you didn't request this, ignore this email.</p>
      </div>
    `,
  });
}
