/**
 * The "Use with Claude / ChatGPT / Grok" panel: GET /api/assistants and the
 * per-client links (web/src/lib/assistant-connect.ts).
 *
 *   - any signed-in member, a viewer included, reads it; anonymous is 401
 *   - enabled only when the MCP feature is on AND requires sign-in (oauth)
 *   - the MCP URL is built from the request's own origin
 *   - Claude gets the documented prefill link; ChatGPT and Grok open their
 *     connector pages (no prefill link exists for them)
 *   - Chipp is offered only on Chipp (member sync env set); POST /chipp mints
 *     a short-lived token on the documented wire contract, bound to the
 *     project, the member's email and the request's origin
 */

import { assert, assertEquals } from "@std/assert";
import * as jose from "jose";
import { createHmac } from "node:crypto";
import { app } from "../../../app.ts";
import { createIsolatedUser } from "../helpers.ts";
import { createSessionToken } from "@/api/middleware/auth.ts";
import { setFeatureForTests } from "@/lib/features.ts";
import { __deleteEnvForTest, __setEnvForTest, getEnv } from "@/lib/env.ts";
import { ASSISTANT_TARGETS } from "../../../web/src/lib/assistant-connect.ts";
import { chippWebUrl } from "@/services/chipp-assistant-connect.ts";

const HAS_DB = !!(getEnv("TEST_DATABASE_URL") || getEnv("DATABASE_URL"));

const SECRET = "e".repeat(64);
const PROJECT_ID = "7a6b5c4d-3e2f-4a1b-9c8d-7e6f5a4b3c2d";

/** The platform's key derivation, written out independently of the service. */
function connectKey(secret = SECRET): Uint8Array {
  const hex = createHmac("sha256", new TextEncoder().encode(secret)).update("assistant-connect:v1")
    .digest("hex");
  return new TextEncoder().encode(hex);
}

async function startChipp(cookie?: string) {
  return await app.request("/api/assistants/chipp", {
    method: "POST",
    headers: {
      host: "acme.example.com",
      "x-forwarded-proto": "https",
      "content-type": "application/json",
      ...(cookie ? { cookie } : {}),
    },
    body: "{}",
  });
}

async function getInfo(cookie?: string) {
  return await app.request("/api/assistants", {
    headers: {
      host: "acme.example.com",
      "x-forwarded-proto": "https",
      ...(cookie ? { cookie } : {}),
    },
  });
}

Deno.test({
  name: "assistants: a viewer sees the MCP URL once MCP is on with sign-in; off otherwise",
  ignore: !HAS_DB,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const viewer = await createIsolatedUser("viewer");
    try {
      const cookie = `session_id=${await createSessionToken(viewer.user)}`;
      assertEquals((await getInfo()).status, 401);

      setFeatureForTests("mcp", false);
      let body = (await (await getInfo(cookie)).json()).data;
      assertEquals(body.enabled, false);
      assertEquals(body.mcpUrl, null);

      setFeatureForTests("mcp", true);
      __setEnvForTest("MCP_AUTH_MODE", "public");
      body = (await (await getInfo(cookie)).json()).data;
      assertEquals(body.enabled, false);

      __setEnvForTest("MCP_AUTH_MODE", "oauth");
      body = (await (await getInfo(cookie)).json()).data;
      assertEquals(body.enabled, true);
      assertEquals(body.mcpUrl, "https://acme.example.com/api/mcp");
      assert(typeof body.appName === "string" && body.appName.length > 0);
      assertEquals(body.chipp, false);
    } finally {
      setFeatureForTests("mcp", null);
      __deleteEnvForTest("MCP_AUTH_MODE");
      await viewer.cleanup();
    }
  },
});

Deno.test("assistants: per-client links", () => {
  const byId = Object.fromEntries(ASSISTANT_TARGETS.map((t) => [t.id, t]));
  const connector = { name: "Acme & Co", mcpUrl: "https://acme.example.com/api/mcp" };

  const claude = new URL(byId.claude.url(connector));
  assertEquals(claude.origin + claude.pathname, "https://claude.ai/customize/connectors");
  assertEquals(claude.searchParams.get("modal"), "add-custom-connector");
  assertEquals(claude.searchParams.get("connectorName"), "Acme & Co");
  assertEquals(claude.searchParams.get("connectorUrl"), connector.mcpUrl);
  assertEquals(byId.claude.prefills, true);

  assertEquals(byId.chatgpt.url(connector), "https://chatgpt.com/plugins");
  assertEquals(byId.chatgpt.prefills, false);
  assertEquals(byId.grok.url(connector), "https://grok.com/connectors");
  assertEquals(byId.grok.prefills, false);
});

Deno.test({
  name: "assistants: Chipp is offered on Chipp only, and POST /chipp signs the member to the project",
  ignore: !HAS_DB,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const viewer = await createIsolatedUser("viewer");
    try {
      const cookie = `session_id=${await createSessionToken(viewer.user)}`;
      setFeatureForTests("mcp", true);
      __setEnvForTest("MCP_AUTH_MODE", "oauth");
      __deleteEnvForTest("ALCH_MEMBER_SYNC_SECRET");
      __setEnvForTest("PROJECT_ID", PROJECT_ID);

      // Not on Chipp: no Chipp row and no token.
      assertEquals((await (await getInfo(cookie)).json()).data.chipp, false);
      assertEquals((await startChipp(cookie)).status, 404);

      __setEnvForTest("ALCH_MEMBER_SYNC_SECRET", SECRET);
      assertEquals((await startChipp()).status, 401);
      assertEquals((await (await getInfo(cookie)).json()).data.chipp, true);

      const res = await startChipp(cookie);
      assertEquals(res.status, 200);
      assertEquals(res.headers.get("cache-control"), "no-store");
      const { action, token } = (await res.json()).data;
      assertEquals(action, "https://build.chipp.ai/api/assistant-connect");

      const { payload, protectedHeader } = await jose.jwtVerify(token, connectKey(), {
        algorithms: ["HS256"],
        issuer: "alchemist-app",
        audience: "chipp-assistant-connect",
        typ: "alch-assistant-connect+jwt",
      });
      assertEquals(protectedHeader.alg, "HS256");
      assertEquals(payload.sub, PROJECT_ID);
      assertEquals(payload.email, viewer.user.email.toLowerCase());
      assertEquals(payload.origin, "https://acme.example.com");
      assert(typeof payload.jti === "string" && payload.jti.length >= 16);
      assertEquals((payload.exp ?? 0) - (payload.iat ?? 0), 120);

      // Another key (a handoff key, another project's secret) cannot verify it.
      let rejected = false;
      try {
        await jose.jwtVerify(token, connectKey("d".repeat(64)), { algorithms: ["HS256"] });
      } catch {
        rejected = true;
      }
      assert(rejected);

      // MCP sign-in off: no token even on Chipp.
      __setEnvForTest("MCP_AUTH_MODE", "public");
      assertEquals((await startChipp(cookie)).status, 404);
    } finally {
      setFeatureForTests("mcp", null);
      __deleteEnvForTest("MCP_AUTH_MODE");
      __deleteEnvForTest("ALCH_MEMBER_SYNC_SECRET");
      __deleteEnvForTest("PROJECT_ID");
      await viewer.cleanup();
    }
  },
});

Deno.test("assistants: chippWebUrl defaults to Chipp and honors CHIPP_WEB_URL", () => {
  try {
    __deleteEnvForTest("CHIPP_WEB_URL");
    assertEquals(chippWebUrl(), "https://build.chipp.ai");
    __setEnvForTest("CHIPP_WEB_URL", "http://localhost:5173/");
    assertEquals(chippWebUrl(), "http://localhost:5173");
    __setEnvForTest("CHIPP_WEB_URL", "javascript:alert(1)");
    assertEquals(chippWebUrl(), "https://build.chipp.ai");
  } finally {
    __deleteEnvForTest("CHIPP_WEB_URL");
  }
});
