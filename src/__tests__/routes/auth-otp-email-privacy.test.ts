/**
 * The sign-in code never leaves the email body. It used to open the subject
 * ("123456 is your App verification code"), and the transport logged every
 * subject, so live codes sat in production logs. Subjects also show on lock
 * screens.
 */
import { assert, assertEquals } from "@std/assert";
import { dbTest, withTestServer } from "../helpers.ts";
import { authRoutes } from "@/api/routes/auth/index.ts";
import { db } from "@/db/client.ts";
import { lastCapturedEmail, renderEmailKind } from "@/services/email.ts";
import { __deleteEnvForTest, __setEnvForTest, getEnv } from "@/lib/env.ts";

function buildApp() {
  return withTestServer((app) => app.route("/api/auth", authRoutes));
}

function post(app: ReturnType<typeof buildApp>, path: string, body: unknown) {
  return app.request(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function rowsFor(email: string) {
  return await db.selectFrom("otps").select(["otpCode"]).where("email", "=", email).execute();
}

async function cleanupOtps(email: string) {
  await db.deleteFrom("otps").where("email", "=", email).execute();
}

Deno.test("otp email: the code is never in the subject", () => {
  const rendered = renderEmailKind("otp", { otpCode: "864209" });
  assertEquals(rendered.subject.includes("864209"), false, rendered.subject);
  assert(rendered.text.includes("864209"), "the code is still in the body");
});

dbTest("send-otp in production: no log line carries the code", async () => {
  const email = `otp-privacy-${crypto.randomUUID().slice(0, 8)}@example.com`;
  const app = buildApp();
  const prevEnv = getEnv("NODE_ENV");
  const lines: string[] = [];
  const original = { log: console.log, error: console.error, warn: console.warn };
  const capture = (...args: unknown[]) => lines.push(args.map(String).join(" "));
  try {
    __setEnvForTest("NODE_ENV", "production");
    console.log = capture;
    console.error = capture;
    console.warn = capture;
    assertEquals((await post(app, "/api/auth/send-otp", { email })).status, 200);
    // The send is fire-and-forget; wait for the mailbox to record it.
    for (let i = 0; i < 100 && !lastCapturedEmail({ kind: "otp", to: email }); i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    await new Promise((r) => setTimeout(r, 20));
  } finally {
    console.log = original.log;
    console.error = original.error;
    console.warn = original.warn;
    if (prevEnv === undefined) __deleteEnvForTest("NODE_ENV");
    else __setEnvForTest("NODE_ENV", prevEnv);
  }
  try {
    const [{ otpCode: code }] = await rowsFor(email);
    const sent = lastCapturedEmail({ kind: "otp", to: email });
    assert(sent, "the code email was sent");
    assertEquals(sent.subject.includes(code), false, sent.subject);
    assert(lines.length > 0, "the send logged something");
    assertEquals(lines.filter((l) => l.includes(code)), []);
  } finally {
    await cleanupOtps(email);
  }
});
