/**
 * Platform auth mail: sign-in mail goes to Chipp's auth mail service as a
 * structured intent (a kind, one recipient, a code or a link), never as a
 * message. Not configured or unavailable falls back to the app's own
 * transport; a refusal (a limit) never does.
 */
import { assert, assertEquals, assertRejects } from "@std/assert";
import { __deleteEnvForTest, __setEnvForTest } from "@/lib/env.ts";
import {
  _platformAuthMailInternals,
  PlatformAuthMailRefusedError,
  platformAuthMailConfigured,
  sendPlatformAuthMail,
} from "@/services/platform-auth-mail.ts";
import { clearCapturedEmails, lastCapturedEmail, sendEmailKind } from "@/services/email.ts";
import { __setTransportForTest } from "@/services/email-transport.ts";

const ENV = {
  CHIPP_MAIL_URL: "https://platform.chipp.test/",
  CHIPP_MAIL_TOKEN: "tok",
  PROJECT_ID: "11111111-1111-4111-8111-111111111111",
  CHIPP_ORG_ID: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
};
// A real-looking domain: reserved domains never leave the app.
const TO = "person@chipp.ai";

interface Call {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

function configure(status = 200, payload: unknown = { ok: true, from: "noreply@chipp.ai" }): Call[] {
  for (const [k, v] of Object.entries(ENV)) __setEnvForTest(k, v);
  const calls: Call[] = [];
  _platformAuthMailInternals.fetch = (url: string, init: RequestInit) => {
    calls.push({
      url,
      headers: init.headers as Record<string, string>,
      body: JSON.parse(String(init.body)),
    });
    return Promise.resolve(new Response(JSON.stringify(payload), { status }));
  };
  return calls;
}

function reset(): void {
  for (const k of Object.keys(ENV)) __deleteEnvForTest(k);
  _platformAuthMailInternals.fetch = (input: string, init: RequestInit) => fetch(input, init);
}

Deno.test("platform auth mail: unconfigured is unavailable and calls nothing", async () => {
  reset();
  let called = false;
  _platformAuthMailInternals.fetch = () => {
    called = true;
    return Promise.resolve(new Response("{}"));
  };
  assertEquals(platformAuthMailConfigured(), false);
  const r = await sendPlatformAuthMail({ to: TO, intent: { kind: "otp_code", code: "123456" } });
  assertEquals(r.status, "unavailable");
  assertEquals(called, false);
  reset();
});

Deno.test("platform auth mail: sends an intent, never a subject or body", async () => {
  const calls = configure();
  try {
    const r = await sendPlatformAuthMail({ to: TO, intent: { kind: "otp_code", code: "123456" } });
    assertEquals(r.status, "sent");
    assertEquals(calls.length, 1);
    assertEquals(calls[0].url, "https://platform.chipp.test/api/internal/project-mail/auth");
    assertEquals(calls[0].headers["x-chipp-mail-project"], ENV.PROJECT_ID);
    assertEquals(calls[0].headers["x-chipp-mail-org"], ENV.CHIPP_ORG_ID);
    assertEquals(calls[0].body, { kind: "otp_code", to: TO, code: "123456" });
  } finally {
    reset();
  }
});

Deno.test("platform auth mail: 404, 422 and 5xx are unavailable; 429 is a refusal", async () => {
  for (const status of [404, 422, 500, 503]) {
    configure(status, { ok: false, error: "x" });
    const r = await sendPlatformAuthMail({ to: TO, intent: { kind: "otp_code", code: "123456" } });
    assertEquals(r.status, "unavailable", String(status));
    reset();
  }
  configure(429, { ok: false, error: "Too many sign-in messages" });
  try {
    await assertRejects(
      () => sendPlatformAuthMail({ to: TO, intent: { kind: "otp_code", code: "123456" } }),
      PlatformAuthMailRefusedError,
    );
  } finally {
    reset();
  }
});

Deno.test({
  name: "platform auth mail: the otp kind goes to the platform and still reaches the dev mailbox",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const calls = configure();
    try {
      clearCapturedEmails();
      await sendEmailKind({ kind: "otp", to: TO, data: { otpCode: "654321" } });
      assertEquals(calls.length, 1);
      assertEquals(calls[0].body.kind, "otp_code");
      assertEquals(calls[0].body.code, "654321");
      assertEquals(calls[0].body.expiresInMinutes, 30);
      assert("subject" in calls[0].body === false);
      assertEquals(lastCapturedEmail()?.kind, "otp");
    } finally {
      reset();
    }
  },
});

Deno.test({
  name: "platform auth mail: the portal link is a magic_link intent",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const calls = configure();
    try {
      await sendEmailKind({
        kind: "portal_link",
        to: TO,
        data: { organizationName: "Acme", subjectLabel: null, portalUrl: "https://acme.example/#/portal/claim/t" },
      });
      assertEquals(calls.length, 1);
      assertEquals(calls[0].body, { kind: "magic_link", to: TO, link: "https://acme.example/#/portal/claim/t" });
    } finally {
      reset();
    }
  },
});

Deno.test({
  name: "platform auth mail: reserved recipients never reach the platform",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const calls = configure();
    try {
      await sendEmailKind({ kind: "otp", to: "someone@example.com", data: { otpCode: "111111" } });
      assertEquals(calls.length, 0);
    } finally {
      reset();
    }
  },
});

Deno.test("platform auth mail: an older platform that does not know the kind is unavailable", async () => {
  configure(400, { ok: false, error: "kind: one of otp_code, magic_link, email_verification, password_reset" });
  try {
    const r = await sendPlatformAuthMail({ to: TO, intent: { kind: "invitation", link: "https://acme.example/#/invite/t" } });
    assertEquals(r.status, "unavailable");
  } finally {
    reset();
  }
  configure(400, { ok: false, error: "link: required for invitation" });
  try {
    await assertRejects(
      () => sendPlatformAuthMail({ to: TO, intent: { kind: "invitation" } }),
      PlatformAuthMailRefusedError,
    );
  } finally {
    reset();
  }
});

Deno.test({
  name: "platform auth mail: the invite is a link-only invitation intent",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const calls = configure();
    try {
      await sendEmailKind({
        kind: "invite",
        to: TO,
        data: {
          inviterName: "Pat",
          inviterEmail: "pat@chipp.ai",
          organizationName: "Acme",
          roleLabel: "Editor",
          acceptUrl: "https://acme.example/#/invite/tok",
          expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000 + 60_000),
        },
      });
      assertEquals(calls.length, 1);
      assertEquals(calls[0].body, {
        kind: "invitation",
        to: TO,
        link: "https://acme.example/#/invite/tok",
        expiresInMinutes: 7 * 1440,
      });
    } finally {
      reset();
    }
  },
});

Deno.test({
  name: "platform auth mail: an app with its own provider still sends sign-in mail through Chipp",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    // The app's own SMTP (a BYO provider): it must carry ordinary mail only.
    const viaOwnProvider: string[] = [];
    const previous = __setTransportForTest({
      sendMail: (m: { subject?: string }) => {
        viaOwnProvider.push(String(m.subject));
        return Promise.resolve({} as never);
      },
    });
    const calls = configure();
    try {
      await sendEmailKind({ kind: "otp", to: TO, data: { otpCode: "246810" } });
      await sendEmailKind({
        kind: "invite",
        to: TO,
        data: {
          inviterName: null,
          inviterEmail: "pat@chipp.ai",
          organizationName: "Acme",
          roleLabel: "Viewer",
          acceptUrl: "https://acme.example/#/invite/tok",
          expiresAt: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000),
        },
      });
      assertEquals(calls.map((c) => c.body.kind), ["otp_code", "invitation"]);
      assertEquals(viaOwnProvider, []);

      // When Chipp's lane is unavailable, the app's own provider is the fallback.
      _platformAuthMailInternals.fetch = () => Promise.resolve(new Response("{}", { status: 503 }));
      await sendEmailKind({ kind: "otp", to: TO, data: { otpCode: "135791" } });
      assertEquals(viaOwnProvider.length, 1);
    } finally {
      __setTransportForTest(previous);
      reset();
    }
  },
});
