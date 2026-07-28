/**
 * DEMO_MODE outbound-email suppression. `sendEmail()` is the single choke
 * point every transactional email (OTP, invites) routes through, so
 * gating there covers the whole surface without per-caller changes.
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import { sendEmail } from "@/services/email.ts";

function withDemoMode(value: string | undefined, fn: () => Promise<void>): Promise<void> {
  const prev = Deno.env.get("DEMO_MODE");
  if (value === undefined) Deno.env.delete("DEMO_MODE");
  else Deno.env.set("DEMO_MODE", value);
  return fn().finally(() => {
    if (prev === undefined) Deno.env.delete("DEMO_MODE");
    else Deno.env.set("DEMO_MODE", prev);
  });
}

function captureConsoleLog(fn: () => Promise<void>): Promise<string[]> {
  const lines: string[] = [];
  const original = console.log;
  console.log = (...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  };
  return fn().then(() => lines).finally(() => {
    console.log = original;
  });
}

Deno.test("sendEmail: suppresses outbound mail entirely when DEMO_MODE=1", async () => {
  await withDemoMode("1", async () => {
    const lines = await captureConsoleLog(() =>
      sendEmail({
        to: "visitor@example.com",
        subject: "Your verification code",
        text: "123456",
      })
    );

    // Suppressed: a demo-mode notice was logged, never the real send path.
    assertEquals(lines.some((l) => l.includes("[demo-mode]") && l.includes("suppressed")), true);
    assertEquals(lines.some((l) => l.startsWith("[email] To:")), false);
  });
});

Deno.test("sendEmail: falls back to console logging (not suppressed) when DEMO_MODE is off", async () => {
  await withDemoMode(undefined, async () => {
    const lines = await captureConsoleLog(() =>
      sendEmail({
        to: "visitor@example.com",
        subject: "Your verification code",
        text: "123456",
      })
    );

    // No SMTP configured in the test env -> falls back to the existing
    // console.log dev path, unchanged from before DEMO_MODE existed.
    assertEquals(lines.some((l) => l.includes("[demo-mode]")), false);
    const toLine = lines.find((l) => l.startsWith("[email] To:"));
    assertStringIncludes(toLine ?? "", "visitor@example.com");
  });
});
