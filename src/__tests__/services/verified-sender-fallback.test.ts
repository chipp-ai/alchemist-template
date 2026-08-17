/**
 * Source-shape guard: auth-critical mail keeps its verified-sender fallback.
 *
 * Origin (2026-08-17): a customer app deployed from this template shipped an
 * `EMAIL_FROM` on a domain the mail provider had never verified. Every OTP
 * send was refused `550 From header sender domain not verified`, the send-otp
 * route correctly returned 422, and the app's users could not log in at all
 * for hours. Ordinary mail failing is degradation; the login code failing is
 * a lockout, so auth-critical mail retries once from the platform's verified
 * sender.
 *
 * This is a SOURCE-TEXT test on purpose. The behavior lives inside a
 * nodemailer `catch`, and the repo has no SMTP transport fixture to drive a
 * real permanent rejection through; a shape test that pins the wiring is worth
 * more than no test, and it fails loudly the moment someone drops the flag
 * from the OTP path.
 */

import { assert, assertEquals } from "@std/assert";

const SRC = await Deno.readTextFile(new URL("../../services/email.ts", import.meta.url));

Deno.test("sendEmail accepts an authCritical option", () => {
  assert(
    /authCritical\?: boolean/.test(SRC),
    "SendEmailOptions must keep the authCritical flag",
  );
});

Deno.test("the OTP and invite sends are both marked auth-critical", () => {
  // Two call sites: sendOtpEmail and sendInviteEmail. Both are mail a user
  // cannot finish signing in without.
  const marks = SRC.match(/authCritical:\s*true/g) ?? [];
  assertEquals(
    marks.length,
    2,
    "expected exactly 2 authCritical call sites (OTP + invite)",
  );
});

Deno.test("sendOtpEmail specifically is auth-critical", () => {
  const start = SRC.indexOf("export async function sendOtpEmail");
  assert(start > -1, "sendOtpEmail must exist");
  const body = SRC.slice(start);
  const call = body.indexOf("await sendEmail({");
  assert(call > -1, "sendOtpEmail must send through sendEmail");
  assert(
    /authCritical:\s*true/.test(body.slice(call, call + 400)),
    "sendOtpEmail's send must be marked authCritical -- without it a bad " +
      "sender domain locks every user out of login",
  );
});

Deno.test("the fallback reads the platform sender from env, never a literal", () => {
  assert(
    /Deno\.env\.get\("PLATFORM_EMAIL_FROM"\)/.test(SRC),
    "the verified sender must come from PLATFORM_EMAIL_FROM",
  );
  // A hardcoded platform address would be wrong the moment the platform's
  // verified sender changes, and wrong for any self-hosted deployment.
  assert(
    !/noreply@chipp\.ai/.test(SRC),
    "must not hardcode the platform sender address",
  );
});

Deno.test("the fallback pins the SMTP envelope, not just the From header", () => {
  // Providers check the envelope sender as well as the header. Leaving the
  // envelope to nodemailer's default reproduces the same rejection.
  const start = SRC.indexOf("verified-sender-fallback");
  assert(start > -1, "fallback branch must exist");
  assert(
    /envelope:\s*\{\s*from:\s*PLATFORM_EMAIL_FROM/.test(SRC),
    "the fallback send must pin the envelope sender too",
  );
});

Deno.test("the fallback keeps the configured address reachable via Reply-To", () => {
  assert(
    /replyTo:\s*BRAND\.fromEmail/.test(SRC),
    "a reply must still reach the project's own address",
  );
});

Deno.test("the recovered-configuration path warns, it does not page", () => {
  // This repeats on every send until the domain is verified. log.error here
  // would page on a condition we already contained.
  const idx = SRC.indexOf("Sender domain not verified");
  assert(idx > -1, "fallback must log the recovery");
  const before = SRC.slice(Math.max(0, idx - 200), idx);
  assert(before.includes("log.warn"), "the recovered path must use log.warn");
});

Deno.test("the unverified-sender matcher is narrow, not any-5xx", () => {
  // A broad match would retry sends that failed for reasons the fallback
  // cannot fix (bad recipient, blocked message), doubling one honest failure.
  assert(
    /sender domain not verified/.test(SRC),
    "matcher must key on the provider's unverified-sender wording",
  );
  assert(
    !/\b5\d\d\b[^\n]*test\(/.test(SRC),
    "matcher must not treat every 5xx as an unverified sender",
  );
});
