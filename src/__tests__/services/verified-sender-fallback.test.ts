/**
 * Auth-critical mail keeps its verified-sender fallback.
 *
 * Origin (2026-08-17): a customer app deployed from this template shipped an
 * `EMAIL_FROM` on a domain the mail provider had never verified. Every OTP
 * send was refused `550 From header sender domain not verified`, the send-otp
 * route correctly returned 422, and the app's users could not log in at all
 * for hours. Ordinary mail failing is degradation; the login code failing is
 * a lockout, so auth-critical mail retries once from the platform's verified
 * sender.
 *
 * Part of this is a SOURCE-TEXT test on purpose. The fallback lives inside a
 * nodemailer `catch`, and the repo has no SMTP transport fixture to drive a
 * real permanent rejection through; a shape test that pins the wiring is worth
 * more than no test, and it fails loudly the moment someone unpicks it.
 *
 * The "which mail is auth-critical" half is no longer source text. Since the
 * kind registry landed, a kind DECLARES `authCritical` once at registration
 * and the transport reads it, so the honest assertion is against the registry
 * itself -- and it stays correct as kinds are added.
 */

import { assert, assertEquals } from "@std/assert";
import { listEmailKinds } from "@/services/email.ts";

const TRANSPORT = await Deno.readTextFile(
  new URL("../../services/email-transport.ts", import.meta.url),
);
const KINDS = await Deno.readTextFile(
  new URL("../../services/email-kinds.ts", import.meta.url),
);

Deno.test("sendEmail accepts an authCritical option", () => {
  assert(
    /authCritical\?: boolean/.test(TRANSPORT),
    "SendEmailOptions must keep the authCritical flag",
  );
});

Deno.test("the OTP and invite kinds are both registered auth-critical", () => {
  // Both are mail a user cannot finish signing in without: the login code
  // itself, and the link that binds an invitee to a workspace.
  const byKind = new Map(listEmailKinds().map((k) => [k.kind, k.authCritical]));
  assertEquals(byKind.get("otp"), true, "the sign-in code must be auth-critical");
  assertEquals(byKind.get("invite"), true, "the invite link must be auth-critical");
});

Deno.test("ordinary mail is NOT auth-critical -- the flag is not a default", () => {
  // If every kind were auth-critical the communications gate would be dead
  // code. At least one shipped kind must be gate-able.
  const ordinary = listEmailKinds().filter((k) => !k.authCritical);
  assert(ordinary.length > 0, "no gate-able kind is registered");
});

Deno.test("the registry forwards a kind's authCritical flag into the transport", () => {
  // The declaration is worthless if the send path drops it.
  assert(
    /authCritical:\s*def\.authCritical === true/.test(KINDS),
    "sendEmailKind must pass the kind's authCritical flag to sendEmail",
  );
});

Deno.test("the fallback reads the platform sender from env, never a literal", () => {
  assert(
    /Deno\.env\.get\("PLATFORM_EMAIL_FROM"\)/.test(TRANSPORT),
    "the verified sender must come from PLATFORM_EMAIL_FROM",
  );
  // A hardcoded platform address would be wrong the moment the platform's
  // verified sender changes, and wrong for any self-hosted deployment.
  assert(
    !/noreply@chipp\.ai/.test(TRANSPORT),
    "must not hardcode the platform sender address",
  );
});

Deno.test("the fallback pins the SMTP envelope, not just the From header", () => {
  // Providers check the envelope sender as well as the header. Leaving the
  // envelope to nodemailer's default reproduces the same rejection.
  const start = TRANSPORT.indexOf("verified-sender-fallback");
  assert(start > -1, "fallback branch must exist");
  assert(
    /envelope:\s*\{\s*from:\s*PLATFORM_EMAIL_FROM/.test(TRANSPORT),
    "the fallback send must pin the envelope sender too",
  );
});

Deno.test("the fallback keeps the configured address reachable via Reply-To", () => {
  assert(
    /replyTo:\s*BRAND\.fromEmail/.test(TRANSPORT),
    "a reply must still reach the project's own address",
  );
});

Deno.test("the recovered-configuration path warns, it does not page", () => {
  // This repeats on every send until the domain is verified. log.error here
  // would page on a condition we already contained.
  const idx = TRANSPORT.indexOf("Sender domain not verified");
  assert(idx > -1, "fallback must log the recovery");
  const before = TRANSPORT.slice(Math.max(0, idx - 200), idx);
  assert(before.includes("log.warn"), "the recovered path must use log.warn");
});

Deno.test("the unverified-sender matcher is narrow, not any-5xx", () => {
  // A broad match would retry sends that failed for reasons the fallback
  // cannot fix (bad recipient, blocked message), doubling one honest failure.
  assert(
    /sender domain not verified/.test(TRANSPORT),
    "matcher must key on the provider's unverified-sender wording",
  );
  assert(
    !/\b5\d\d\b[^\n]*test\(/.test(TRANSPORT),
    "matcher must not treat every 5xx as an unverified sender",
  );
});

Deno.test("the fallback is reachable only from the auth-critical branch", () => {
  // Ordinary mail must fail honestly rather than quietly re-sending from a
  // different address the recipient did not expect.
  assert(
    /opts\.authCritical === true &&\s*\n?\s*isUnverifiedSenderRejection/.test(TRANSPORT),
    "the fallback guard must require authCritical",
  );
});
