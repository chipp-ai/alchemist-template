/**
 * Restricted mode at the app's own sign-in
 * (src/services/platform-access.service.ts), set through the member sync's
 * optional `access` field.
 *
 * In "restricted" mode sign-in admits only attached members (synced or
 * app-native), pending invitees and allowedEmails. Everyone else gets one
 * plain 403 at send-otp (before a code exists), verify-otp, the social
 * callback (before an account exists) and MCP OAuth authorize. A failed
 * check refuses. "open" and a body without `access` behave as before.
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { app } from "../../../app.ts";
import { createIsolatedUser } from "../helpers.ts";
import { db } from "@/db/client.ts";
import { __deleteEnvForTest, __setEnvForTest, getEnv } from "@/lib/env.ts";
import { signEventBody } from "@/lib/event-signing.ts";
import { createSessionToken } from "@/api/middleware/auth.ts";
import { setFeatureForTests } from "@/lib/features.ts";
import { clientService } from "@/services/mcp-oauth/service.ts";
import { _accessDeps, PRIVATE_APP_MESSAGE } from "@/services/platform-access.service.ts";

const HAS_DB = !!(getEnv("TEST_DATABASE_URL") || getEnv("DATABASE_URL"));
const SECRET = "e".repeat(64);
const PROJECT_ID = "5d1c7b0e-2a3b-4c5d-8e9f-0a1b2c3d4e5f";

let seq = Date.now() * 10;

function dbTest(name: string, fn: () => Promise<void>) {
  Deno.test({
    name,
    ignore: !HAS_DB,
    sanitizeResources: false,
    sanitizeOps: false,
    fn: async () => {
      __setEnvForTest("ALCH_MEMBER_SYNC_SECRET", SECRET);
      __setEnvForTest("PROJECT_ID", PROJECT_ID);
      // Each test starts from no stored seq or access setting (one row,
      // shared by every test in this worker's schema).
      await db.deleteFrom("platform_member_sync_state").execute();
      try {
        await fn();
      } finally {
        __deleteEnvForTest("ALCH_MEMBER_SYNC_SECRET");
        __deleteEnvForTest("PROJECT_ID");
        await db.updateTable("platform_member_sync_state")
          .set({ accessMode: null, allowedEmails: [] })
          .execute();
        await db.deleteFrom("users").where("managedBy", "=", "platform").execute();
      }
    },
  });
}

async function deliver(body: Record<string, unknown>): Promise<Response> {
  seq += 1000;
  const raw = JSON.stringify({ projectId: PROJECT_ID, seq, ...body });
  const ts = Math.floor(Date.now() / 1000);
  return await app.request("/api/platform/member-sync", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "X-Event-Timestamp": String(ts),
      "X-Event-Signature": signEventBody(SECRET, ts, raw),
    },
    body: raw,
  });
}

function email(tag: string): string {
  return `${tag}-${crypto.randomUUID().slice(0, 8)}@access.test.local`;
}

async function sendOtp(address: string): Promise<Response> {
  return await app.request("/api/auth/send-otp", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: address }),
  });
}

async function verifyOtp(address: string): Promise<Response> {
  await db.deleteFrom("otps").where("email", "=", address).execute();
  await db.insertInto("otps")
    .values({ email: address, otpCode: "135790", expiresAt: new Date(Date.now() + 300_000) })
    .execute();
  return await app.request("/api/auth/verify-otp", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: address, otpCode: "135790" }),
  });
}

async function hasOtp(address: string): Promise<boolean> {
  const row = await db.selectFrom("otps").select("id").where("email", "=", address)
    .executeTakeFirst();
  return row !== undefined;
}

async function restrict(
  owner: { user: { email: string } },
  allowed: string[],
  extraMembers: unknown[] = [],
) {
  const res = await deliver({
    members: [{ email: owner.user.email, name: null, role: "owner" }, ...extraMembers],
    access: { mode: "restricted", allowedEmails: allowed },
  });
  assertEquals(res.status, 200, await res.clone().text());
}

dbTest(
  "restricted: send-otp refuses an outsider before a code exists, and admits the allowed",
  async () => {
    const owner = await createIsolatedUser("owner");
    try {
      const allowed = email("allowed");
      const managed = email("managed");
      const invited = email("invited");
      await restrict(owner, [allowed], [{ email: managed, name: null, role: "viewer" }]);
      await db.insertInto("invites").values({
        organizationId: owner.org.id,
        email: invited,
        role: "editor",
        token: crypto.randomUUID(),
        invitedBy: owner.user.id,
        expiresAt: new Date(Date.now() + 86_400_000),
      }).execute();

      const outsider = email("outsider");
      const refused = await sendOtp(outsider);
      assertEquals(refused.status, 403);
      assertEquals((await refused.json()).error, PRIVATE_APP_MESSAGE);
      assertEquals(await hasOtp(outsider), false);

      for (const address of [owner.user.email, allowed, managed, invited]) {
        const ok = await sendOtp(address);
        assertEquals(ok.status, 200, address);
      }
    } finally {
      await owner.cleanup();
    }
  },
);

dbTest(
  "restricted: verify-otp refuses an outsider and a disconnected member; an allowed email gets in",
  async () => {
    const owner = await createIsolatedUser("owner");
    try {
      const allowed = email("allowed");
      const gone = email("gone");
      await restrict(owner, [allowed], [{ email: gone, name: null, role: "viewer" }]);
      // Drop `gone` from the members (soft-disconnect); keep the mode.
      await restrict(owner, [allowed]);

      const outsider = email("outsider");
      const refused = await verifyOtp(outsider);
      assertEquals(refused.status, 403);
      assertEquals(refused.headers.get("set-cookie"), null);
      const noUser = await db.selectFrom("users").select("id").where("email", "=", outsider)
        .executeTakeFirst();
      assertEquals(noUser, undefined);

      assertEquals((await verifyOtp(gone)).status, 403);
      assertEquals((await verifyOtp(allowed)).status, 200);
    } finally {
      await owner.cleanup();
    }
  },
);

dbTest("restricted: a body without access keeps the mode; open admits everyone again", async () => {
  const owner = await createIsolatedUser("owner");
  try {
    await restrict(owner, []);
    await deliver({ members: [{ email: owner.user.email, name: null, role: "owner" }] });
    assertEquals((await sendOtp(email("still-out"))).status, 403);

    await deliver({
      members: [{ email: owner.user.email, name: null, role: "owner" }],
      access: { mode: "open", allowedEmails: [] },
    });
    assertEquals((await sendOtp(email("now-in"))).status, 200);

    await deliver({
      members: [{ email: owner.user.email, name: null, role: "owner" }],
      access: { mode: "sign_in_required", allowedEmails: [] },
    });
    assertEquals((await sendOtp(email("also-in"))).status, 200);
  } finally {
    await owner.cleanup();
  }
});

dbTest(
  "restricted: the social-login callback refuses an outsider and creates no account",
  async () => {
    const owner = await createIsolatedUser("owner");
    const realFetch = globalThis.fetch;
    const outsider = email("social");
    __setEnvForTest("GOOGLE_CLIENT_ID", "test-client");
    __setEnvForTest("GOOGLE_CLIENT_SECRET", "test-secret");
    globalThis.fetch = ((input: string | URL | Request) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.startsWith("https://oauth2.googleapis.com/token")) {
        return Promise.resolve(Response.json({ access_token: "at" }));
      }
      if (url.startsWith("https://www.googleapis.com/oauth2/v2/userinfo")) {
        return Promise.resolve(Response.json({ id: "g-1", email: outsider, name: "Out Sider" }));
      }
      return realFetch(input);
    }) as typeof fetch;
    try {
      await restrict(owner, []);
      const res = await app.request("/api/auth/google/callback?code=abc&state=st", {
        headers: { cookie: "oauth_state_google=st" },
      });
      assertEquals(res.status, 403);
      const row = await db.selectFrom("users").select("id").where("email", "=", outsider)
        .executeTakeFirst();
      assertEquals(row, undefined);
    } finally {
      globalThis.fetch = realFetch;
      __deleteEnvForTest("GOOGLE_CLIENT_ID");
      __deleteEnvForTest("GOOGLE_CLIENT_SECRET");
      await owner.cleanup();
    }
  },
);

dbTest(
  "restricted: MCP OAuth authorize refuses a non-admitted session, and a failed check refuses",
  async () => {
    const owner = await createIsolatedUser("owner");
    setFeatureForTests("mcp", true);
    const realDecide = _accessDeps.decide;
    try {
      const { clientId } = await clientService.register({
        redirectUris: ["http://localhost:9999/cb"],
        clientName: "access test",
      });
      const cookie = `session_id=${await createSessionToken(owner.user)}`;
      const url = `/api/mcp/oauth/authorize?client_id=${clientId}&redirect_uri=${
        encodeURIComponent("http://localhost:9999/cb")
      }&response_type=code&code_challenge=abc&code_challenge_method=S256`;

      // An attached member is admitted even in restricted mode.
      await restrict(owner, []);
      assertEquals((await app.request(url, { headers: { cookie } })).status, 200);

      _accessDeps.decide = () => Promise.resolve({ mode: "restricted", admitted: false });
      const refused = await app.request(url, { headers: { cookie } });
      assertEquals(refused.status, 403);
      assertStringIncludes(await refused.text(), "This app is private");
      const post = await app.request("/api/mcp/oauth/authorize", {
        method: "POST",
        headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          action: "approve",
          client_id: clientId,
          redirect_uri: "http://localhost:9999/cb",
          code_challenge: "abc",
        }),
      });
      assertEquals(post.status, 403);

      // Fail closed: the check itself fails.
      _accessDeps.decide = () => Promise.reject(new Error("db down"));
      const failed = await sendOtp(email("dbdown"));
      assertEquals(failed.status, 403);
      assert(!(await failed.text()).includes("db down"));
    } finally {
      _accessDeps.decide = realDecide;
      setFeatureForTests("mcp", null);
      await owner.cleanup();
    }
  },
);
