/**
 * Bulk sender policy (src/services/mailing/sender-policy.ts): a campaign
 * never sends from the shared platform sender.
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { evaluateBulkSender } from "@/services/mailing/sender-policy.ts";

const PLATFORM = "noreply@chipp.ai";

Deno.test("sender: the shared platform sender is blocked, with the fix", () => {
  const s = evaluateBulkSender({
    fromEmail: PLATFORM,
    platformEmailFrom: PLATFORM,
    smtpConfigured: true,
  });
  assertEquals(s.allowed, false);
  assertEquals(s.code, "shared_platform_sender");
  assertStringIncludes(s.message, "noreply@chipp.ai");
  assertStringIncludes(s.message, "Settings, go to Emails");
  assertStringIncludes(s.message, "Sign-in codes");
  assert(!s.message.includes("\u2014"), "no em dashes in builder copy");
});

Deno.test("sender: any address on a shared domain is blocked, even with no PLATFORM_EMAIL_FROM", () => {
  for (const from of ["news@chipp.ai", "hello@app.chipp.ai", "noreply@myapp.adaas.dev"]) {
    const s = evaluateBulkSender({ fromEmail: from, platformEmailFrom: "", smtpConfigured: true });
    assertEquals(s.code, "shared_platform_sender", from);
  }
});

Deno.test("sender: the platform sender's own domain is shared, whatever it is", () => {
  const s = evaluateBulkSender({
    fromEmail: "x@mail.platform.example.net",
    platformEmailFrom: "noreply@platform.example.net",
    smtpConfigured: true,
  });
  assertEquals(s.allowed, false);
  const viaEnv = evaluateBulkSender({
    fromEmail: "x@alch.io",
    platformEmailFrom: "",
    smtpConfigured: true,
    platformDomain: "alch.io",
  });
  assertEquals(viaEnv.allowed, false);
});

Deno.test("sender: no sender of its own (placeholder) is blocked", () => {
  const s = evaluateBulkSender({
    fromEmail: "noreply@example.com",
    platformEmailFrom: PLATFORM,
    smtpConfigured: true,
  });
  assertEquals(s.code, "no_sender");
  assertEquals(s.allowed, false);
});

Deno.test("sender: a verified customer domain is allowed", () => {
  const s = evaluateBulkSender({
    fromEmail: "News@Mail.YourBrand.com",
    platformEmailFrom: PLATFORM,
    smtpConfigured: true,
  });
  assertEquals(s.allowed, true);
  assertEquals(s.code, "customer_domain");
  assertEquals(s.domain, "mail.yourbrand.com");
});

Deno.test("sender: a domain that only ends with a shared name is not shared", () => {
  const s = evaluateBulkSender({
    fromEmail: "a@notchipp.ai",
    platformEmailFrom: PLATFORM,
    smtpConfigured: true,
  });
  assertEquals(s.allowed, true);
});

Deno.test("sender: with no SMTP nothing leaves the pod, so dev may run campaigns", () => {
  const s = evaluateBulkSender({
    fromEmail: "noreply@example.com",
    platformEmailFrom: "",
    smtpConfigured: false,
  });
  assertEquals(s.allowed, true);
  assertEquals(s.code, "dev_capture");
});
