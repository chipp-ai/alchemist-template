/**
 * Email Service -- the front door.
 *
 * This file is a facade. Import outbound email from here and you get the
 * whole paved road; the pieces live next door:
 *
 *   email-transport.ts        sendEmail(): DEMO_MODE -> communications gate
 *                             -> dev-mailbox capture -> SMTP / console
 *   email-kinds.ts            the kind registry + the branded shell.
 *                             Registering a kind is how you add an email.
 *   email-mailbox.ts          the in-memory capture buffer tests assert on
 *   communications.service.ts the org toggle + per-user preference
 *
 * The rules that matter:
 *
 *   - To add an email, `registerEmailKind({...})`. Never re-create the
 *     branded shell, and never hand-roll a `sendEmail` call with its own
 *     markup.
 *   - Mark a kind `authCritical` ONLY when a person cannot finish signing
 *     in without it. Auth-critical mail skips the communications gate.
 *   - `sendTestEmail()` bypasses the gate on purpose. It is the "prove
 *     delivery works" path and must never be blocked by the toggle an
 *     admin is debugging.
 *   - In tests, assert on `listCapturedEmails()` / `lastCapturedEmail()`.
 *     Never scrape the console.
 */

export {
  isSmtpConfigured,
  mailboxCaptureEnabled,
  sendEmail,
  type SendEmailOptions,
} from "@/services/email-transport.ts";

export {
  brandedEmailShell,
  type EmailKindDefinition,
  escapeHtml,
  type InviteEmailData,
  listEmailKinds,
  type OtpEmailData,
  registerEmailKind,
  type RenderedEmail,
  renderEmailKind,
  renderEmailKindPreview,
  type SendInviteEmailOptions,
  sendEmailKind,
  sendInviteEmail,
  sendOtpEmail,
  sendTestEmail,
  TEST_EMAIL_SUBJECT_PREFIX,
} from "@/services/email-kinds.ts";

export {
  capturedEmailCount,
  type CapturedEmail,
  clearCapturedEmails,
  lastCapturedEmail,
  listCapturedEmails,
  MAX_CAPTURED_EMAILS,
} from "@/services/email-mailbox.ts";

export {
  checkCommunicationsSuppression,
  getOrgCommunicationsEnabled,
  getUserCommunicationsEnabled,
  setOrgCommunicationsEnabled,
  setUserCommunicationsEnabled,
  type SuppressionReason,
  USER_COMMUNICATIONS_PREF_KEY,
  userWantsCommunications,
} from "@/services/communications.service.ts";
