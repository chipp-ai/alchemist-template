/**
 * Sender identity + headers: what the transport composes per send.
 *
 * Ordinary (non-auth-critical) mail carries an RFC 8058 one-click
 * unsubscribe (List-Unsubscribe with a signed https POST endpoint, plus
 * List-Unsubscribe-Post); auth-critical mail carries none. The sender
 * snapshot (describeEmailSender) is the /api/dev surface an agent reads to
 * see the effective From without reading env.
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { __deleteEnvForTest, __setEnvForTest } from "@/lib/env.ts";
import {
  signUnsubscribeToken,
  verifyUnsubscribeToken,
} from "@/services/mailing/unsubscribe-token.ts";
import { describeEmailSender, effectiveSendHeaders } from "@/services/email-transport.ts";
import {
  clearCapturedEmails,
  lastCapturedEmail,
  registerEmailKind,
  sendEmailKind,
  sendOtpEmail,
} from "@/services/email.ts";

function deno(name: string, fn: () => void | Promise<void>) {
  Deno.test({ name, sanitizeResources: false, sanitizeOps: false, fn });
}

// ── effectiveSendHeaders (pure) ───────────────────────────────────────────

deno("headers: ordinary mail gets a one-click unsubscribe pair", () => {
  const h = effectiveSendHeaders({ to: "Pat@Example.org", organizationId: "org-1" });
  const lu = h?.["List-Unsubscribe"] ?? "";
  assert(lu.startsWith("<http"), lu);
  assertStringIncludes(lu, "/api/unsubscribe/");
  assertEquals(h?.["List-Unsubscribe-Post"], "List-Unsubscribe=One-Click");
  // The link is signed for exactly this recipient and workspace.
  const token = lu.slice(
    lu.indexOf("/api/unsubscribe/") + "/api/unsubscribe/".length,
    lu.indexOf(">"),
  );
  assertEquals(verifyUnsubscribeToken(token), {
    email: "pat@example.org",
    organizationId: "org-1",
  });
});

deno("headers: a mailto is added only when EMAIL_UNSUBSCRIBE_MAILTO is set", () => {
  assert(
    !(effectiveSendHeaders({ to: "a@b.org" })?.["List-Unsubscribe"] ?? "").includes("mailto:"),
  );
  __setEnvForTest("EMAIL_UNSUBSCRIBE_MAILTO", "unsubscribe@inbound.yourbrand.com");
  try {
    const lu = effectiveSendHeaders({ to: "a@b.org" })?.["List-Unsubscribe"] ?? "";
    assertStringIncludes(lu, ", <mailto:unsubscribe@inbound.yourbrand.com?subject=unsubscribe>");
  } finally {
    __deleteEnvForTest("EMAIL_UNSUBSCRIBE_MAILTO");
  }
});

deno("headers: with no recipient the settings page is the fallback", () => {
  const h = effectiveSendHeaders({});
  assertStringIncludes(h?.["List-Unsubscribe"] ?? "", "settings?tab=notifications>");
  assertEquals(h?.["List-Unsubscribe-Post"], undefined);
});

deno("unsubscribe token: forged, edited and malformed tokens are refused", () => {
  const good = signUnsubscribeToken({ email: "pat@example.org", organizationId: null });
  assertEquals(verifyUnsubscribeToken(good), { email: "pat@example.org", organizationId: null });
  const [payload, sig] = good.split(".");
  const otherPayload = btoa("v1||mallory@example.org").replace(/=+$/, "").replace(/\+/g, "-")
    .replace(/\//g, "_");
  assertEquals(verifyUnsubscribeToken(`${otherPayload}.${sig}`), null);
  assertEquals(verifyUnsubscribeToken(`${payload}.${sig.slice(0, -2)}AA`), null);
  assertEquals(verifyUnsubscribeToken("nonsense"), null);
  assertEquals(verifyUnsubscribeToken(""), null);
  assertEquals(verifyUnsubscribeToken("a.b.c"), null);
});

deno("headers: a caller-supplied List-Unsubscribe wins", () => {
  const h = effectiveSendHeaders({
    to: "a@b.org",
    headers: { "List-Unsubscribe": "<https://one-click.example/unsub>" },
  });
  assertEquals(h?.["List-Unsubscribe"], "<https://one-click.example/unsub>");
  assertEquals(h?.["List-Unsubscribe-Post"], undefined);
});

deno("headers: auth-critical mail advertises no unsubscribe", () => {
  assertEquals(effectiveSendHeaders({ authCritical: true }), undefined);
});

deno("headers: auth-critical passes a custom header through", () => {
  const h = effectiveSendHeaders({ authCritical: true, headers: { "X-Custom": "1" } });
  assertEquals(h?.["X-Custom"], "1");
  assertEquals(h?.["List-Unsubscribe"], undefined);
});

// ── Through the real transport, asserted on the mailbox ───────────────────
// The communications gate fails OPEN when there is no DB, so these run
// with or without one.

registerEmailKind<{ who: string }>({
  kind: "headers_test_ordinary",
  description: "Test-only ordinary kind for header assertions.",
  subject: (d) => `Hi ${d.who}`,
  text: (d) => `Hi ${d.who}`,
  body: (d) => ({ html: `<p>Hi ${d.who}</p>` }),
  sample: () => ({ who: "world" }),
});

deno("headers: an ordinary send is captured with List-Unsubscribe", async () => {
  clearCapturedEmails();
  await sendEmailKind({
    kind: "headers_test_ordinary",
    to: "headers-ordinary@test.local",
    data: { who: "world" },
  });
  const captured = lastCapturedEmail({ kind: "headers_test_ordinary" });
  assertStringIncludes(captured?.headers?.["List-Unsubscribe"] ?? "", "/api/unsubscribe/");
  assertEquals(captured?.headers?.["List-Unsubscribe-Post"], "List-Unsubscribe=One-Click");
});

deno("headers: an auth-critical send is captured without one", async () => {
  clearCapturedEmails();
  await sendOtpEmail("headers-auth@test.local", "123456");
  const captured = lastCapturedEmail({ kind: "otp" });
  assertEquals(captured?.headers?.["List-Unsubscribe"], undefined);
  assertEquals(captured?.headers?.["List-Unsubscribe-Post"], undefined);
});

// ── Sender snapshot ───────────────────────────────────────────────────────

deno("sender snapshot: the effective From is Name <address>", () => {
  const info = describeEmailSender();
  assertEquals(info.from, `${info.fromName} <${info.fromEmail}>`);
  assertEquals(typeof info.smtpConfigured, "boolean");
});
