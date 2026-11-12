/**
 * The "Use with Claude / ChatGPT / Grok" panel: GET /api/assistants and the
 * per-client links (web/src/lib/assistant-connect.ts).
 *
 *   - any signed-in member, a viewer included, reads it; anonymous is 401
 *   - enabled only when the MCP feature is on AND requires sign-in (oauth)
 *   - the MCP URL is built from the request's own origin
 *   - Claude gets the documented prefill link; ChatGPT and Grok open their
 *     connector pages (no prefill link exists for them)
 */

import { assert, assertEquals } from "@std/assert";
import { app } from "../../../app.ts";
import { createIsolatedUser } from "../helpers.ts";
import { createSessionToken } from "@/api/middleware/auth.ts";
import { setFeatureForTests } from "@/lib/features.ts";
import { __deleteEnvForTest, __setEnvForTest, getEnv } from "@/lib/env.ts";
import { ASSISTANT_TARGETS } from "../../../web/src/lib/assistant-connect.ts";

const HAS_DB = !!(getEnv("TEST_DATABASE_URL") || getEnv("DATABASE_URL"));

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
