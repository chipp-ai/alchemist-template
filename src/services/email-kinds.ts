/**
 * Email kind registry -- the branded shell, built once.
 *
 * A "kind" is one named, typed message: a subject builder, a plain-text
 * builder, and an HTML body that the registry drops into the shared
 * branded shell. Adding a new email is ONE `registerEmailKind({...})`
 * call. It is never a copy of the shell markup, and never a fresh
 * `sendEmail` call site with its own `<table>` soup.
 *
 * What registration buys, free, for every kind:
 *
 *   - the branded shell (top rule, wordmark, footer, dark-safe palette)
 *   - the communications gate, or an explicit auth-critical bypass
 *   - dev-mailbox capture tagged with the kind, so tests assert on it
 *   - `GET /api/email/kinds/:kind/preview` renders it with sample data
 *   - `POST /api/email/test` sends it to an admin as a [TEST] message
 *
 * Adding a kind:
 *
 *   registerEmailKind<{ name: string }>({
 *     kind: "welcome",
 *     description: "Sent once after a user's first sign-in.",
 *     subject: (d) => `Welcome, ${d.name}`,
 *     text: (d) => `Welcome, ${d.name}.`,
 *     body: (d) => ({ previewText: "Welcome", html: `<p>Hi ${escapeHtml(d.name)}</p>` }),
 *     sample: () => ({ name: "Sample Person" }),
 *   });
 *
 * Then `await sendEmailKind({ kind: "welcome", to, data: { name } })`.
 * Register from a module `main.ts` imports (same rule as the inbound-email
 * extraction profile) or the preview and test-send surfaces will not see it.
 *
 * ESCAPE EVERY INTERPOLATED VALUE in `body` with `escapeHtml`. The shell
 * does not sanitize what a kind hands it.
 */

import { BRAND } from "@/config/brand.ts";
import { NotFoundError } from "@/utils/errors.ts";
import { sendEmail } from "@/services/email-transport.ts";

// ── Registry types ─────────────────────────────────────────────────────────

export interface RenderedEmail {
  subject: string;
  text: string;
  html: string;
}

export interface EmailKindDefinition<TData> {
  /** Stable machine name. Recorded on captured mail; used in routes. */
  kind: string;
  /** One line, shown in the admin kind list and the preview page. */
  description: string;
  /**
   * True when a user cannot finish signing in without this message (OTP
   * code, invite acceptance link, portal access link). Auth-critical mail
   * SKIPS the communications gate and gets the verified-sender fallback.
   * Everything else must be false: an org that muted notifications must
   * actually be muted.
   */
  authCritical?: boolean;
  subject: (data: TData) => string;
  text: (data: TData) => string;
  /** Inner HTML. The shell is applied by the registry, never by the kind. */
  body: (data: TData) => { previewText?: string; html: string };
  /** Representative data for the preview route and the test send. */
  sample: () => TData;
}

// deno-lint-ignore no-explicit-any
const registry = new Map<string, EmailKindDefinition<any>>();

/**
 * Register one kind. Throws on a duplicate name: two kinds answering to
 * the same string would make the preview and test-send routes ambiguous,
 * and the loser would be silently unreachable.
 */
export function registerEmailKind<TData>(def: EmailKindDefinition<TData>): void {
  if (registry.has(def.kind)) {
    throw new Error(`Email kind "${def.kind}" is already registered.`);
  }
  registry.set(def.kind, def);
}

/** Every registered kind, sorted by name. */
export function listEmailKinds(): Array<{
  kind: string;
  description: string;
  authCritical: boolean;
}> {
  return [...registry.values()]
    .map((d) => ({
      kind: d.kind,
      description: d.description,
      authCritical: d.authCritical === true,
    }))
    .sort((a, b) => a.kind.localeCompare(b.kind));
}

// deno-lint-ignore no-explicit-any
function requireKind(kind: string): EmailKindDefinition<any> {
  const def = registry.get(kind);
  if (!def) {
    throw new NotFoundError("Email kind", `No email kind named "${kind}" is registered.`);
  }
  return def;
}

/** Render a kind to its final subject / text / branded HTML. */
export function renderEmailKind<TData>(kind: string, data: TData): RenderedEmail {
  const def = requireKind(kind);
  const body = def.body(data);
  return {
    subject: def.subject(data),
    text: def.text(data),
    html: brandedEmailShell({ previewText: body.previewText, bodyHtml: body.html }),
  };
}

/** Render a kind with its own sample data. Backs the preview route. */
export function renderEmailKindPreview(kind: string): RenderedEmail {
  const def = requireKind(kind);
  return renderEmailKind(kind, def.sample());
}

/** Send a registered kind. The normal way to send anything. */
export async function sendEmailKind<TData>(opts: {
  kind: string;
  to: string;
  data: TData;
  /** Org whose communications toggle applies. Omit to use the recipient's own. */
  organizationId?: string | null;
}): Promise<void> {
  const def = requireKind(opts.kind);
  const rendered = renderEmailKind(opts.kind, opts.data);
  await sendEmail({
    to: opts.to,
    kind: def.kind,
    organizationId: opts.organizationId ?? null,
    authCritical: def.authCritical === true,
    subject: rendered.subject,
    text: rendered.text,
    html: rendered.html,
  });
}

/** Subject marker on every test send, so nobody mistakes one for real mail. */
export const TEST_EMAIL_SUBJECT_PREFIX = "[TEST] ";

/**
 * Send a registered kind, rendered with its sample data, to one address.
 *
 * BYPASSES THE COMMUNICATIONS GATE BY DESIGN. This is the "prove delivery
 * works" button; running it through the org toggle makes it fail exactly
 * when someone is debugging why mail stopped arriving. That was a real
 * defect on a customer project: the gate blocked its own test path.
 *
 * The rest of the pipeline is unchanged (same shell, same transport, same
 * auth-critical handling), so a successful test send is real evidence.
 */
export async function sendTestEmail(opts: {
  kind: string;
  to: string;
  organizationId?: string | null;
}): Promise<RenderedEmail> {
  const def = requireKind(opts.kind);
  const rendered = renderEmailKind(opts.kind, def.sample());
  const subject = `${TEST_EMAIL_SUBJECT_PREFIX}${rendered.subject}`;

  await sendEmail({
    to: opts.to,
    kind: def.kind,
    organizationId: opts.organizationId ?? null,
    authCritical: def.authCritical === true,
    bypassSuppression: true,
    subject,
    text: rendered.text,
    html: rendered.html,
  });

  return { ...rendered, subject };
}

// ── Branded email shell ───────────────────────────────────────────────────
// Table-based, inline-styled, webfont-free (email clients strip <style> and
// block @font-face) -- the brand pop is the primary color (top rule, accents)
// plus the logo / serif wordmark. Warm-neutral ink + canvas read well under
// ANY brand color, so a customer with only a primary set still gets a
// polished, on-brand email. The serif stack degrades to Georgia where
// Cormorant can't load (i.e. every mail client) -- still editorial.
export const EMAIL_SERIF = "'Cormorant Garamond', Georgia, 'Times New Roman', serif";
export const EMAIL_SANS =
  "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";
export const EMAIL_MONO =
  "'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";
export const EMAIL_INK = "#1a1712";
export const EMAIL_MUTED = "#6b6457";
export const EMAIL_FAINT = "#9a917f";
const EMAIL_PAGE_BG = "#f4f2ec";
const EMAIL_BORDER = "#e7e1d4";

/**
 * Minimal HTML escape for email interpolation. Only safe for text nodes +
 * attribute values, which is all we use it for here. Every kind must run
 * interpolated values through this.
 */
export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * The shared shell. Exported for the preview surface; kinds get it applied
 * for them by `renderEmailKind` and must not call it directly.
 */
export function brandedEmailShell(opts: { previewText?: string; bodyHtml: string }): string {
  const primary = BRAND.primaryColor;
  // Serif wordmark in the brand color -- not the logo image. Reliable across
  // every mail client (no blocked-image / wrong-variant / low-contrast
  // surprises: a brand's logo may be a light-on-dark mark that vanishes on
  // the white card), high-contrast, and unmistakably on-brand.
  const header =
    `<span style="font-family:${EMAIL_SERIF};font-size:27px;font-weight:700;letter-spacing:-0.01em;color:${primary};">${
      escapeHtml(BRAND.name)
    }</span>`;
  const preview = opts.previewText
    ? `<div style="display:none;max-height:0;overflow:hidden;mso-hide:all;opacity:0;color:transparent;">${
      escapeHtml(opts.previewText)
    }</div>`
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

/** Shared primary-color button. Kinds use this instead of re-styling one. */
function ctaButton(href: string, label: string): string {
  return `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 0 26px;">
          <tr><td style="background:${BRAND.primaryColor};border-radius:10px;">
            <a href="${
    escapeHtml(href)
  }" style="display:inline-block;padding:13px 26px;font-family:${EMAIL_SANS};font-size:15px;font-weight:700;color:#ffffff;text-decoration:none;">${
    escapeHtml(label)
  }</a>
          </td></tr>
        </table>`;
}

/** Shared "or paste this link" fallback block. */
function linkFallback(href: string): string {
  return `<p style="margin:0 0 4px;font-family:${EMAIL_SANS};font-size:12px;color:${EMAIL_FAINT};">Or paste this link into your browser:</p>
        <p style="margin:0;font-family:${EMAIL_MONO};font-size:12px;line-height:1.5;word-break:break-all;"><a href="${
    escapeHtml(href)
  }" style="color:${BRAND.primaryColor};">${escapeHtml(href)}</a></p>`;
}

// ── Built-in kinds ─────────────────────────────────────────────────────────

export interface InviteEmailData {
  /** Inviter's display name; falls back to inviterEmail when null/empty. */
  inviterName: string | null;
  inviterEmail: string;
  organizationName: string;
  /** UI label for the role being offered ("Editor", "Admin", "Viewer"). */
  roleLabel: string;
  acceptUrl: string;
  expiresAt: Date;
}

/** Inviter display + the " on <App>" suffix, shared by subject and body. */
function inviteParts(d: InviteEmailData) {
  const appName = BRAND.name;
  const inviterDisplay = d.inviterName?.trim() || d.inviterEmail;
  // " on <App>" suffix -- but only when the org name differs from the app
  // name. Many single-tenant apps name the org after the app, which
  // produced the awkward "invited you to Valor Victoria on Valor
  // Victoria". The branded "from" + accept page already convey the app,
  // so dropping the redundant suffix reads cleaner.
  const onApp = appName && appName.toLowerCase() !== d.organizationName.toLowerCase()
    ? ` on ${appName}`
    : "";
  // "Expires in N days" copy. Floors so a 6.99-day-old invite reads "6 days".
  const msUntilExpiry = d.expiresAt.getTime() - Date.now();
  const daysLeft = Math.max(1, Math.floor(msUntilExpiry / (1000 * 60 * 60 * 24)));
  return { inviterDisplay, onApp, daysLeft };
}

registerEmailKind<InviteEmailData>({
  kind: "invite",
  description: "Team invite with an acceptance link. Sent by an admin from Settings.",
  // Auth-critical: the link IS the recipient's way into the workspace.
  authCritical: true,
  subject: (d) => {
    const { inviterDisplay, onApp } = inviteParts(d);
    return `${inviterDisplay} invited you to ${d.organizationName}${onApp}`;
  },
  text: (d) => {
    const { inviterDisplay, onApp, daysLeft } = inviteParts(d);
    return [
      `${inviterDisplay} invited you to join ${d.organizationName}${onApp}`,
      `as ${d.roleLabel}.`,
      "",
      "Accept the invite:",
      d.acceptUrl,
      "",
      `This invite expires in ${daysLeft} day${daysLeft === 1 ? "" : "s"}.`,
      "",
      `If you don't recognize the sender, you can safely ignore this email.`,
    ].join("\n");
  },
  body: (d) => {
    const { inviterDisplay, onApp, daysLeft } = inviteParts(d);
    return {
      previewText: `${inviterDisplay} invited you to join ${d.organizationName}${onApp}`,
      html: `
        <h1 style="margin:0 0 10px;font-family:${EMAIL_SERIF};font-size:31px;font-weight:600;line-height:1.1;color:${EMAIL_INK};">You're invited</h1>
        <p style="margin:0 0 26px;font-family:${EMAIL_SANS};font-size:15px;line-height:1.55;color:${EMAIL_MUTED};">
          <strong style="color:${EMAIL_INK};">${
        escapeHtml(inviterDisplay)
      }</strong> invited you to join
          <strong style="color:${EMAIL_INK};">${escapeHtml(d.organizationName)}</strong>${
        escapeHtml(onApp)
      }
          as <strong style="color:${EMAIL_INK};">${escapeHtml(d.roleLabel)}</strong>.
        </p>
        ${ctaButton(d.acceptUrl, "Accept invite")}
        ${linkFallback(d.acceptUrl)}
        <p style="margin:26px 0 0;font-family:${EMAIL_SANS};font-size:13px;line-height:1.5;color:${EMAIL_FAINT};">
          This invite expires in ${daysLeft} day${daysLeft === 1 ? "" : "s"}.
          If you don't recognize the sender, you can safely ignore this email.
        </p>
      `,
    };
  },
  sample: () => ({
    inviterName: "Sample Admin",
    inviterEmail: "admin@example.invalid",
    organizationName: BRAND.name,
    roleLabel: "Editor",
    acceptUrl: `${appUrl()}/#/invite/sample-token`,
    expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
  }),
});

export interface OtpEmailData {
  otpCode: string;
}

registerEmailKind<OtpEmailData>({
  kind: "otp",
  description: "Sign-in verification code. Sent on every passwordless login.",
  authCritical: true,
  subject: (d) => `${d.otpCode} is your ${BRAND.name} verification code`,
  text: (d) =>
    [
      `Your verification code is: ${d.otpCode}`,
      "",
      "This code expires in 10 minutes.",
      "",
      `If you didn't request this code, you can safely ignore this email.`,
    ].join("\n"),
  body: (d) => ({
    previewText: `${d.otpCode} -- your ${BRAND.name} verification code (expires in 10 minutes)`,
    html: `
        <h1 style="margin:0 0 10px;font-family:${EMAIL_SERIF};font-size:31px;font-weight:600;line-height:1.1;color:${EMAIL_INK};">Verification code</h1>
        <p style="margin:0 0 26px;font-family:${EMAIL_SANS};font-size:15px;line-height:1.5;color:${EMAIL_MUTED};">Enter this code to sign in to ${
      escapeHtml(BRAND.name)
    }.</p>
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
          <tr><td align="center" style="background:#faf8f3;border:2px solid ${BRAND.primaryColor};border-radius:12px;padding:24px 16px;">
            <span style="font-family:${EMAIL_MONO};font-size:40px;font-weight:700;letter-spacing:14px;color:${EMAIL_INK};padding-left:14px;">${
      escapeHtml(d.otpCode)
    }</span>
          </td></tr>
        </table>
        <p style="margin:26px 0 0;font-family:${EMAIL_SANS};font-size:13px;line-height:1.5;color:${EMAIL_FAINT};">This code expires in 10 minutes. If you didn't request it, you can safely ignore this email.</p>
      `,
  }),
  sample: () => ({ otpCode: "123456" }),
});

export interface ExpirationDigestRecord {
  label: string;
  expiresAt: Date;
  detail?: string | null;
  url?: string | null;
}

export interface ExpirationDigestData {
  organizationName: string;
  /** Plural noun: "certifications", "contracts". */
  recordLabel: string;
  withinDays: number;
  records: ExpirationDigestRecord[];
}

/**
 * The scheduled-alert scaffold's message. ORDINARY mail on purpose: it
 * goes through the communications gate, so a muted org gets nothing.
 * See src/services/expiration-digest.ts for the job that sends it.
 */
registerEmailKind<ExpirationDigestData>({
  kind: "expiration_digest",
  description: "Digest of records expiring soon. Sent by the scheduled expiration job.",
  subject: (d) =>
    `${d.records.length} ${d.recordLabel} expiring in the next ${d.withinDays} days`,
  text: (d) =>
    [
      `${d.records.length} ${d.recordLabel} in ${d.organizationName} expire within ${d.withinDays} days:`,
      "",
      ...d.records.map((r) =>
        `- ${r.label} (expires ${formatDate(r.expiresAt)})${r.detail ? ` -- ${r.detail}` : ""}`
      ),
      "",
      "You are receiving this because you administer this workspace.",
    ].join("\n"),
  body: (d) => ({
    previewText: `${d.records.length} ${d.recordLabel} expiring within ${d.withinDays} days`,
    html: `
        <h1 style="margin:0 0 10px;font-family:${EMAIL_SERIF};font-size:31px;font-weight:600;line-height:1.1;color:${EMAIL_INK};">Expiring soon</h1>
        <p style="margin:0 0 22px;font-family:${EMAIL_SANS};font-size:15px;line-height:1.55;color:${EMAIL_MUTED};">
          <strong style="color:${EMAIL_INK};">${d.records.length}</strong> ${
      escapeHtml(d.recordLabel)
    } in
          <strong style="color:${EMAIL_INK};">${
      escapeHtml(d.organizationName)
    }</strong> expire within the next ${d.withinDays} days.
        </p>
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 24px;">
          ${
      d.records.map((r) => `
          <tr><td style="padding:12px 0;border-bottom:1px solid ${EMAIL_BORDER};font-family:${EMAIL_SANS};font-size:14px;line-height:1.45;color:${EMAIL_INK};">
            ${
        r.url
          ? `<a href="${escapeHtml(r.url)}" style="color:${BRAND.primaryColor};text-decoration:none;">${
            escapeHtml(r.label)
          }</a>`
          : escapeHtml(r.label)
      }
            <div style="font-size:12px;color:${EMAIL_FAINT};">Expires ${
        escapeHtml(formatDate(r.expiresAt))
      }${r.detail ? ` &middot; ${escapeHtml(r.detail)}` : ""}</div>
          </td></tr>`).join("")
    }
        </table>
        <p style="margin:0;font-family:${EMAIL_SANS};font-size:13px;line-height:1.5;color:${EMAIL_FAINT};">
          You are receiving this because you administer this workspace. Turn these off in Settings.
        </p>
      `,
  }),
  sample: () => ({
    organizationName: BRAND.name,
    recordLabel: "records",
    withinDays: 30,
    records: [
      {
        label: "Sample record A",
        expiresAt: new Date(Date.now() + 5 * 24 * 60 * 60 * 1000),
        detail: "Sample detail line",
      },
      { label: "Sample record B", expiresAt: new Date(Date.now() + 21 * 24 * 60 * 60 * 1000) },
    ],
  }),
});

/** Stable, locale-independent date for email copy: "12 Mar 2026". */
function formatDate(d: Date): string {
  const months = [
    "Jan",
    "Feb",
    "Mar",
    "Apr",
    "May",
    "Jun",
    "Jul",
    "Aug",
    "Sep",
    "Oct",
    "Nov",
    "Dec",
  ];
  return `${d.getUTCDate()} ${months[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

// ── Back-compatible wrappers ───────────────────────────────────────────────
// Same names, same signatures, same behavior as before the registry existed.
// New code should call `sendEmailKind` directly.

export interface SendInviteEmailOptions extends InviteEmailData {
  to: string;
}

/**
 * Send an invite email to a prospective team member.
 *
 * Falls back to the dev mailbox + console in dev (when SMTP isn't
 * configured) -- the acceptUrl is captured so the agent can grab it
 * during local testing without a real inbox.
 */
export async function sendInviteEmail(opts: SendInviteEmailOptions): Promise<void> {
  const { to, ...data } = opts;
  await sendEmailKind<InviteEmailData>({ kind: "invite", to, data });
}

export async function sendOtpEmail(to: string, otpCode: string): Promise<void> {
  await sendEmailKind<OtpEmailData>({ kind: "otp", to, data: { otpCode } });
}

// ── Internals ──────────────────────────────────────────────────────────────

function appUrl(): string {
  try {
    return Deno.env.get("APP_URL") ?? "http://localhost:8000";
  } catch {
    return "http://localhost:8000";
  }
}

export { appUrl as emailAppUrl, ctaButton as emailCtaButton, linkFallback as emailLinkFallback };
