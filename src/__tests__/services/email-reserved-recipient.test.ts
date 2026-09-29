/**
 * Reserved recipient domains never reach SMTP.
 *
 * A real send to example.com / *.test / *.invalid bounces, and bounces get
 * the sending account flagged. `sendEmail` still records the message in the
 * dev mailbox, so tests that assert on the mailbox keep working.
 */
import { assertEquals, assertExists } from "@std/assert";
import { clearCapturedEmails, isReservedRecipientAddress, lastCapturedEmail, sendEmail } from "@/services/email.ts";

Deno.test("reserved recipient: RFC 2606 / 6761 names and test.com are reserved", () => {
  for (
    const to of [
      "a@example.com",
      "A@Example.COM",
      "a@mail.example.org",
      "a@example.net",
      "a@test.com",
      "a@foo.test",
      "a@site.example",
      "a@x.invalid",
      "a@localhost",
      "Name <a@example.com>",
    ]
  ) {
    assertEquals(isReservedRecipientAddress(to), true, to);
  }
});

Deno.test("reserved recipient: real domains and look-alikes are not reserved", () => {
  for (
    const to of [
      "a@chipp.ai",
      "a@gmail.com",
      "a@notexample.com",
      "a@example.com.au",
      "a@contest.com",
      "a@testing.io",
      "not-an-address",
    ]
  ) {
    assertEquals(isReservedRecipientAddress(to), false, to);
  }
});

Deno.test({
  name: "reserved recipient: sendEmail still records the message in the dev mailbox",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    clearCapturedEmails();
    await sendEmail({ to: "buyer@example.com", subject: "Receipt", text: "Thanks", bypassSuppression: true });
    const captured = lastCapturedEmail();
    assertExists(captured);
    assertEquals(captured.to, "buyer@example.com");
  },
});
