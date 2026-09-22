/**
 * Sender identity + headers — what the transport composes per send.
 *
 * Ordinary (non-auth-critical) mail carries a List-Unsubscribe pointer at
 * the app's notification settings; auth-critical mail carries none. The
 * sender snapshot (describeEmailSender) is the /api/dev surface an agent
 * reads to see the effective From without reading env.
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
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

deno("headers: ordinary mail points at the notification settings", () => {
  const h = effectiveSendHeaders({});
  assertStringIncludes(h?.["List-Unsubscribe"] ?? "", "/#");
  assertStringIncludes(h?.["List-Unsubscribe"] ?? "", "settings?tab=notifications>");
});

deno("headers: a caller-supplied List-Unsubscribe wins", () => {
  const h = effectiveSendHeaders({
    headers: { "List-Unsubscribe": "<https://one-click.example/unsub>" },
  });
  assertEquals(h?.["List-Unsubscribe"], "<https://one-click.example/unsub>");
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
  assertEquals(
    captured?.headers?.["List-Unsubscribe"]?.endsWith("/#/settings?tab=notifications>"),
    true,
  );
});

deno("headers: an auth-critical send is captured without one", async () => {
  clearCapturedEmails();
  await sendOtpEmail("headers-auth@test.local", "123456");
  const captured = lastCapturedEmail({ kind: "otp" });
  assertEquals(captured?.headers?.["List-Unsubscribe"], undefined);
});

// ── Sender snapshot ───────────────────────────────────────────────────────

deno("sender snapshot: the effective From is Name <address>", () => {
  const info = describeEmailSender();
  assertEquals(info.from, `${info.fromName} <${info.fromEmail}>`);
  assertEquals(typeof info.smtpConfigured, "boolean");
});
