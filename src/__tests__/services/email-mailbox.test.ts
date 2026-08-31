/**
 * Dev mailbox -- the capture seam every other email test asserts through.
 *
 * Covers the ring buffer itself (bounding, filtering, clearing) and the
 * one behavior that makes it usable as a test seam: an ordinary
 * `sendEmail()` in a suite with no SMTP lands in it, tagged with its kind.
 *
 * No console scraping anywhere in this file, on purpose. Console output is
 * for humans tailing a dev server; assertions read the buffer.
 */

import { assertEquals, assertExists, assertStringIncludes } from "@std/assert";
import {
  capturedEmailCount,
  clearCapturedEmails,
  lastCapturedEmail,
  listCapturedEmails,
  MAX_CAPTURED_EMAILS,
  mailboxCaptureEnabled,
  sendEmail,
} from "@/services/email.ts";
import { captureEmail } from "@/services/email-mailbox.ts";

function deno(name: string, fn: () => void | Promise<void>) {
  Deno.test({ name, sanitizeResources: false, sanitizeOps: false, fn });
}

function entry(overrides: Partial<{ kind: string | null; to: string; subject: string }> = {}) {
  return captureEmail({
    kind: overrides.kind ?? null,
    to: overrides.to ?? "someone@test.local",
    from: "Test <noreply@test.local>",
    subject: overrides.subject ?? "Subject",
    text: "body",
    html: null,
  });
}

deno("mailbox: capture is ON in the suite (no SMTP configured)", () => {
  assertEquals(mailboxCaptureEnabled(), true);
});

deno("mailbox: captures in send order and clears", () => {
  clearCapturedEmails();
  entry({ subject: "first" });
  entry({ subject: "second" });

  const all = listCapturedEmails();
  assertEquals(all.length, 2);
  assertEquals(all[0].subject, "first");
  assertEquals(all[1].subject, "second");
  assertEquals(lastCapturedEmail()?.subject, "second");

  assertEquals(clearCapturedEmails(), 2);
  assertEquals(capturedEmailCount(), 0);
});

deno("mailbox: seq is monotonic and `since` returns only newer entries", () => {
  clearCapturedEmails();
  const first = entry({ subject: "one" });
  const second = entry({ subject: "two" });

  assertEquals(second.seq > first.seq, true);
  const newer = listCapturedEmails({ since: first.seq });
  assertEquals(newer.length, 1);
  assertEquals(newer[0].subject, "two");
  clearCapturedEmails();
});

deno("mailbox: filters by kind and by recipient (case-insensitive)", () => {
  clearCapturedEmails();
  entry({ kind: "invite", to: "Alice@Test.Local" });
  entry({ kind: "otp", to: "bob@test.local" });

  assertEquals(listCapturedEmails({ kind: "invite" }).length, 1);
  assertEquals(listCapturedEmails({ to: "alice@test.local" }).length, 1);
  assertEquals(listCapturedEmails({ to: "ALICE@TEST.LOCAL" })[0].kind, "invite");
  assertEquals(listCapturedEmails({ kind: "nope" }).length, 0);
  clearCapturedEmails();
});

deno("mailbox: is a bounded ring buffer -- oldest entries drop", () => {
  clearCapturedEmails();
  for (let i = 0; i < MAX_CAPTURED_EMAILS + 25; i++) {
    entry({ subject: `msg-${i}` });
  }

  assertEquals(capturedEmailCount(), MAX_CAPTURED_EMAILS);
  const all = listCapturedEmails();
  // The newest survived; the first 25 were evicted.
  assertEquals(all[all.length - 1].subject, `msg-${MAX_CAPTURED_EMAILS + 24}`);
  assertEquals(all[0].subject, "msg-25");
  clearCapturedEmails();
});

deno("mailbox: sendEmail lands in the buffer with its kind and body", async () => {
  clearCapturedEmails();
  await sendEmail({
    to: "capture-target@test.local",
    subject: "Captured subject",
    text: "Captured body",
    html: "<p>Captured body</p>",
    kind: "unit_test",
    // Auth-critical so this test asserts capture, not gate behavior.
    authCritical: true,
  });

  const captured = lastCapturedEmail({ kind: "unit_test" });
  assertExists(captured);
  assertEquals(captured.to, "capture-target@test.local");
  assertEquals(captured.subject, "Captured subject");
  assertEquals(captured.text, "Captured body");
  assertStringIncludes(captured.html ?? "", "Captured body");
  assertExists(captured.sentAt);
  clearCapturedEmails();
});
