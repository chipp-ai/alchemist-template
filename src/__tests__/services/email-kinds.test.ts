/**
 * Email kind registry -- registration, rendering, and the back-compatible
 * wrappers.
 *
 * The point of the registry is that a new email is ONE registration and
 * never a second copy of the branded shell. These tests hold that line:
 * every kind renders through the shell, an unknown kind is a clean 404,
 * and `sendInviteEmail` / `sendOtpEmail` keep their old signatures while
 * routing through the registry.
 */

import { assertEquals, assertRejects, assertStringIncludes, assertThrows } from "@std/assert";
import {
  clearCapturedEmails,
  lastCapturedEmail,
  listEmailKinds,
  registerEmailKind,
  renderEmailKind,
  renderEmailKindPreview,
  sendInviteEmail,
  sendOtpEmail,
} from "@/services/email.ts";
import { sendEmailKind } from "@/services/email-kinds.ts";
import { BRAND } from "@/config/brand.ts";

function deno(name: string, fn: () => void | Promise<void>) {
  Deno.test({ name, sanitizeResources: false, sanitizeOps: false, fn });
}

// ── Registry ──────────────────────────────────────────────────────────────

deno("registry: the built-in kinds are registered", () => {
  const names = listEmailKinds().map((k) => k.kind);
  for (const expected of ["invite", "otp", "expiration_digest"]) {
    assertEquals(names.includes(expected), true, `missing built-in kind "${expected}"`);
  }
});

deno("registry: auth-critical is declared per kind, not guessed", () => {
  const byKind = new Map(listEmailKinds().map((k) => [k.kind, k]));
  // Sign-in code and invite link: a suppressed one locks a person out.
  assertEquals(byKind.get("otp")?.authCritical, true);
  assertEquals(byKind.get("invite")?.authCritical, true);
  // A digest is ordinary mail and must stay gate-able.
  assertEquals(byKind.get("expiration_digest")?.authCritical, false);
});

deno("registry: registering a duplicate kind name throws", () => {
  assertThrows(
    () =>
      registerEmailKind({
        kind: "otp",
        description: "duplicate",
        subject: () => "x",
        text: () => "x",
        body: () => ({ html: "x" }),
        sample: () => ({}),
      }),
    Error,
    "already registered",
  );
});

deno("registry: an unknown kind is a NotFoundError, not a crash", async () => {
  assertThrows(() => renderEmailKindPreview("no-such-kind"), Error, "no-such-kind");
  await assertRejects(
    () => sendEmailKind({ kind: "no-such-kind", to: "nobody@test.local", data: {} }),
    Error,
    "no-such-kind",
  );
});

// ── Shell ─────────────────────────────────────────────────────────────────

deno("shell: every registered kind renders inside the branded shell", () => {
  for (const { kind } of listEmailKinds()) {
    const rendered = renderEmailKindPreview(kind);
    assertStringIncludes(rendered.html, "<!doctype html>", `${kind} skipped the shell`);
    assertStringIncludes(rendered.html, BRAND.name, `${kind} lost the brand wordmark`);
    assertEquals(rendered.subject.length > 0, true, `${kind} has an empty subject`);
    assertEquals(rendered.text.length > 0, true, `${kind} has an empty text body`);
  }
});

deno("shell: interpolated values are HTML-escaped", () => {
  const rendered = renderEmailKind("invite", {
    inviterName: '<script>alert("x")</script>',
    inviterEmail: "attacker@test.local",
    organizationName: "Acme & Co",
    roleLabel: "Editor",
    acceptUrl: "https://example.invalid/#/invite/token",
    expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
  });

  assertEquals(rendered.html.includes("<script>"), false);
  assertStringIncludes(rendered.html, "&lt;script&gt;");
  assertStringIncludes(rendered.html, "Acme &amp; Co");
});

// ── Back-compatible wrappers ──────────────────────────────────────────────

deno("sendInviteEmail: same signature, now captured as kind=invite", async () => {
  clearCapturedEmails();
  await sendInviteEmail({
    to: "invitee@test.local",
    inviterName: "Ada",
    inviterEmail: "ada@test.local",
    organizationName: "Acme",
    roleLabel: "Editor",
    acceptUrl: "https://example.invalid/#/invite/abc123",
    expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
  });

  const captured = lastCapturedEmail({ kind: "invite" });
  assertEquals(captured?.to, "invitee@test.local");
  assertStringIncludes(captured?.subject ?? "", "Ada invited you to Acme");
  // The accept URL survives into BOTH bodies -- the plain-text one is what
  // an agent grabs during local verification.
  assertStringIncludes(captured?.text ?? "", "https://example.invalid/#/invite/abc123");
  assertStringIncludes(captured?.html ?? "", "abc123");
  clearCapturedEmails();
});

deno("sendOtpEmail: same signature, now captured as kind=otp", async () => {
  clearCapturedEmails();
  await sendOtpEmail("signin@test.local", "424242");

  const captured = lastCapturedEmail({ kind: "otp" });
  assertEquals(captured?.to, "signin@test.local");
  assertStringIncludes(captured?.subject ?? "", "424242");
  assertStringIncludes(captured?.text ?? "", "424242");
  assertStringIncludes(captured?.html ?? "", "424242");
  clearCapturedEmails();
});
