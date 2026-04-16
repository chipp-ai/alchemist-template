/**
 * Email Service
 *
 * Sends transactional emails via SMTP (nodemailer).
 * Falls back to console.log when SMTP is not configured (dev mode).
 */

import nodemailer from "nodemailer";
import { log } from "@/lib/logger.ts";

// ── Config ──────────────────────────────────────────────────────────────────

const SMTP_HOST = Deno.env.get("SMTP_HOST");
const SMTP_PORT = parseInt(Deno.env.get("SMTP_PORT") ?? "465", 10);
const SMTP_USERNAME = Deno.env.get("SMTP_USERNAME");
const SMTP_PASSWORD = Deno.env.get("SMTP_PASSWORD");
const EMAIL_FROM = Deno.env.get("EMAIL_FROM") ?? "noreply@alchemist.ai";

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

// ── OTP Email ───────────────────────────────────────────────────────────────

export async function sendOtpEmail(to: string, otpCode: string): Promise<void> {
  const appName = Deno.env.get("APP_NAME") ?? "Alchemist";

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
