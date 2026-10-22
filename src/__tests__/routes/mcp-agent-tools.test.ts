// deno-lint-ignore-file no-explicit-any
/**
 * The agent-tools bridge on the public MCP server (/api/mcp), through the
 * real app.ts mount, with the MCP feature on for this worker only.
 *
 * What it must guarantee (src/mcp/agent-tools-bridge.ts):
 *   - oauth mode: no token is a 401 with the RFC 9728 challenge
 *   - an anonymous caller in public mode gets no agent tools (fail closed)
 *   - an OAuth token or mcp_sk_ key gets the agent tools its CURRENT role
 *     allows; a demotion applies on the next request
 *   - a portal viewer gets only portal-safe tools
 *   - another org's row id is "not found"
 *   - write tools carry destructiveHint; read tools carry readOnlyHint
 *   - a read-only token (tools:read) gets no write tools
 *   - feature off: 404
 *   - the discovery document advertises the bridge (the platform's status
 *     probe reads it)
 *   - "Log out of all devices" disconnects every assistant: access and
 *     refresh tokens issued before it stop working
 * Plus pure checks of the JSON Schema to zod conversion.
 */

import { assert, assertEquals, assertExists } from "@std/assert";
import { app } from "../../../app.ts";
import { createIsolatedUser } from "../helpers.ts";
import { setFeatureForTests } from "@/lib/features.ts";
import { __deleteEnvForTest, __setEnvForTest, getEnv } from "@/lib/env.ts";
import { clientService, oauthTokenService } from "@/services/mcp-oauth/service.ts";
import { mcpApiKeyService } from "@/services/mcp-oauth/api-key.service.ts";
import { db } from "@/db/client.ts";
import { createSessionToken } from "@/api/middleware/auth.ts";
import { AGENT_TOOLS_BRIDGE_VERSION } from "@/api/routes/well-known.ts";
import { jsonSchemaToZod, objectShape, scopeAllows } from "@/mcp/agent-tools-bridge.ts";
import { type AgentTool, registerAgentTool } from "@/services/agent-tools/registry.ts";

const HAS_DB = !!(getEnv("TEST_DATABASE_URL") || getEnv("DATABASE_URL"));

function dbTest(name: string, fn: () => Promise<void>, featureOn = true) {
  Deno.test({
    name,
    ignore: !HAS_DB,
    sanitizeResources: false,
    sanitizeOps: false,
    fn: async () => {
      setFeatureForTests("mcp", featureOn);
      try {
        await fn();
      } finally {
        setFeatureForTests("mcp", null);
        __deleteEnvForTest("MCP_AUTH_MODE");
      }
    },
  });
}

// Feature-pack tools (support_*) are pinned by their own pack's test, and
// this file's own test tool is checked on its own.
const FEATURE_PACK_TOOL = /^(support_|bridge_test_)/;

// A test-only tool above viewer, so a demotion is visible.
const ADMIN_TOOL = "bridge_test_admin_tool";
registerAgentTool({
  name: ADMIN_TOOL,
  description: "test only",
  inputSchema: { type: "object", properties: {} },
  capability: "team.invite",
  write: false,
  handler: () => ({ ok: true }),
});

/** Every listed tool name, test tool included. */
async function allToolNames(bearer?: string): Promise<string[]> {
  const { body } = await rpc("tools/list", {}, bearer);
  return body.result.tools.map((t: any) => t.name);
}
// The MCP registry's example tools, always listed alongside.
const REGISTRY_TOOLS = new Set(["echo", "get_team_summary"]);

let rpcId = 0;
async function rpc(method: string, params: unknown, bearer?: string) {
  const res = await app.request("/api/mcp", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }),
  });
  const text = await res.text();
  if (res.status !== 200) return { status: res.status, body: text ? JSON.parse(text) : null, res };
  const json = text.trimStart().startsWith("{")
    ? text
    : text.split("\n").find((l) => l.startsWith("data: "))!.slice("data: ".length);
  return { status: res.status, body: JSON.parse(json), res };
}

async function listTools(bearer?: string): Promise<any[]> {
  const { status, body } = await rpc("tools/list", {}, bearer);
  assertEquals(status, 200, JSON.stringify(body));
  return body.result.tools.filter((t: any) => !FEATURE_PACK_TOOL.test(t.name));
}

async function agentToolNames(bearer?: string): Promise<string[]> {
  return (await listTools(bearer))
    .map((t) => t.name)
    .filter((n) => !REGISTRY_TOOLS.has(n))
    .sort();
}

async function oauthToken(userId: string, scopes = ["tools:write"]): Promise<string> {
  const { clientId } = await clientService.register({
    redirectUris: ["http://localhost:9999/cb"],
    clientName: "bridge test",
  });
  return (await oauthTokenService.issueTokens({ userId, clientId, scopes })).accessToken;
}

const STARTER_ALL = [
  "get_current_user",
  "get_file",
  "list_files",
  "list_my_portal_records",
  "list_team_members",
  "update_my_profile",
];

dbTest("mcp agent tools: feature off is a 404", async () => {
  const res = await app.request("/api/mcp", { method: "POST", body: "{}" });
  assertEquals(res.status, 404);
}, false);

dbTest(
  "mcp agent tools: oauth mode without a token is a 401 with the RFC 9728 challenge",
  async () => {
    __setEnvForTest("MCP_AUTH_MODE", "oauth");
    const { status, res } = await rpc("tools/list", {});
    assertEquals(status, 401);
    assert(
      (res.headers.get("www-authenticate") ?? "").includes(
        "/.well-known/oauth-protected-resource",
      ),
    );
  },
);

dbTest("mcp agent tools: an anonymous caller in public mode gets no agent tools", async () => {
  assertEquals(await agentToolNames(), []);
  const { body } = await rpc("tools/call", { name: "list_team_members", arguments: {} });
  assertEquals(body.result?.isError ?? true, true);
});

dbTest(
  "mcp agent tools: an OAuth token gets the agent tools, with confirmation hints on writes",
  async () => {
    __setEnvForTest("MCP_AUTH_MODE", "oauth");
    const a = await createIsolatedUser("owner");
    try {
      const token = await oauthToken(a.user.id);
      assertEquals(await agentToolNames(token), STARTER_ALL);
      const tools = await listTools(token);
      const write = tools.find((t) => t.name === "update_my_profile");
      assertEquals(write.annotations.destructiveHint, true);
      assertEquals(write.annotations.readOnlyHint, false);
      const read = tools.find((t) => t.name === "list_team_members");
      assertEquals(read.annotations.readOnlyHint, true);
      // The real argument shape is advertised.
      const getFile = tools.find((t) => t.name === "get_file");
      assertExists(getFile.inputSchema.properties.fileId);

      const { body } = await rpc("tools/call", { name: "get_current_user", arguments: {} }, token);
      assertEquals(body.result.isError ?? false, false);
      assertEquals(body.result.structuredContent.user.email, a.user.email);
    } finally {
      await a.cleanup();
    }
  },
);

dbTest("mcp agent tools: a read-only token gets no write tools", async () => {
  const a = await createIsolatedUser("owner");
  try {
    const key = await mcpApiKeyService.mint({
      userId: a.user.id,
      name: "ro",
      scopes: ["tools:read"],
    });
    const names = await agentToolNames(key.key);
    assert(names.includes("list_team_members"));
    assert(!names.includes("update_my_profile"));
  } finally {
    await a.cleanup();
  }
});

dbTest("mcp agent tools: the role is re-read on every request", async () => {
  const a = await createIsolatedUser("owner");
  try {
    const key = await mcpApiKeyService.mint({
      userId: a.user.id,
      name: "k",
      scopes: ["tools:write"],
    });
    const before = await allToolNames(key.key);
    assert(before.includes(ADMIN_TOOL));
    await db.updateTable("users").set({ role: "viewer" }).where("id", "=", a.user.id).execute();
    const after = await allToolNames(key.key);
    assert(!after.includes(ADMIN_TOOL), "a demoted user loses the admin tool at once");
    assert(after.includes("list_team_members"));
    const { body } = await rpc("tools/call", { name: ADMIN_TOOL, arguments: {} }, key.key);
    assertEquals(body.result?.isError ?? true, true, "a hidden tool cannot be called");
  } finally {
    await a.cleanup();
  }
});

dbTest("mcp agent tools: another org's file id is not found", async () => {
  const a = await createIsolatedUser("owner");
  const b = await createIsolatedUser("owner");
  try {
    const file = await db
      .insertInto("uploaded_files")
      .values({
        organizationId: b.org.id,
        uploadedBy: b.user.id,
        storageKey: `uploads/${b.org.id}/${crypto.randomUUID()}.pdf`,
        filename: "b-secret.pdf",
        contentType: "application/pdf",
        sizeBytes: 10,
        status: "approved",
      })
      .returning(["id"])
      .executeTakeFirstOrThrow();
    const token = await oauthToken(a.user.id);
    const { body } = await rpc(
      "tools/call",
      { name: "get_file", arguments: { fileId: file.id } },
      token,
    );
    assertEquals(body.result.isError, true);
    assert(!JSON.stringify(body).includes("b-secret.pdf"));
  } finally {
    await a.cleanup();
    await b.cleanup();
  }
});

dbTest("mcp agent tools: a portal viewer gets only portal-safe tools", async () => {
  const org = await createIsolatedUser("owner");
  try {
    const portalUser = await db
      .insertInto("users")
      .values({
        email: `portal-${crypto.randomUUID()}@mcp-agent-tools.test.local`,
        name: "Portal Person",
        role: "viewer",
        organizationId: org.org.id,
        emailVerified: true,
      })
      .returning(["id"])
      .executeTakeFirstOrThrow();
    await db.insertInto("portal_access_tokens").values({
      organizationId: org.org.id,
      userId: portalUser.id,
      email: `portal-${portalUser.id}@mcp-agent-tools.test.local`,
      subjectType: "project",
      subjectId: "project-42",
      tokenHash: crypto.randomUUID(),
    }).execute();
    const token = await oauthToken(portalUser.id);
    assertEquals(await agentToolNames(token), [
      "get_current_user",
      "list_my_portal_records",
      "update_my_profile",
    ]);
  } finally {
    await org.cleanup();
  }
});

dbTest("mcp agent tools: the discovery document advertises the bridge", async () => {
  for (
    const path of [
      "/.well-known/oauth-protected-resource",
      "/.well-known/oauth-protected-resource/api/mcp",
    ]
  ) {
    const res = await app.request(path);
    assertEquals(res.status, 200);
    const doc = await res.json();
    assertExists(doc.resource);
    assertEquals(doc.chipp_agent_tools, AGENT_TOOLS_BRIDGE_VERSION);
  }
});

dbTest("mcp agent tools: logout-all disconnects every assistant", async () => {
  __setEnvForTest("MCP_AUTH_MODE", "oauth");
  const a = await createIsolatedUser("owner");
  try {
    const { clientId } = await clientService.register({
      redirectUris: ["http://localhost:9999/cb"],
      clientName: "logout-all test",
    });
    const pair = await oauthTokenService.issueTokens({
      userId: a.user.id,
      clientId,
      scopes: ["tools:write"],
    });
    assertEquals(await agentToolNames(pair.accessToken), STARTER_ALL);

    const session = await createSessionToken(a.user);
    const out = await app.request("/api/auth/logout-all", {
      method: "POST",
      headers: { cookie: `session_id=${session}` },
    });
    assertEquals(out.status, 200);
    await out.body?.cancel();

    assertEquals((await rpc("tools/list", {}, pair.accessToken)).status, 401);
    assertEquals(await oauthTokenService.refreshTokens(pair.refreshToken, clientId), null);
  } finally {
    await a.cleanup();
  }
});

dbTest(
  "mcp agent tools: a token pair issued before the logout-all cutoff is refused even unrevoked",
  async () => {
    __setEnvForTest("MCP_AUTH_MODE", "oauth");
    const a = await createIsolatedUser("owner");
    try {
      const { clientId } = await clientService.register({
        redirectUris: ["http://localhost:9999/cb"],
        clientName: "cutoff test",
      });
      const pair = await oauthTokenService.issueTokens({
        userId: a.user.id,
        clientId,
        scopes: ["tools:write"],
      });
      assertEquals(await agentToolNames(pair.accessToken), STARTER_ALL);
      // The cutoff set by another path, with no revoke of the rows.
      await db.updateTable("users")
        .set({ tokenInvalidatedBefore: new Date(Date.now() + 60_000) })
        .where("id", "=", a.user.id)
        .execute();
      assertEquals(await oauthTokenService.lookupByAccessToken(pair.accessToken), null);
      assertEquals(await oauthTokenService.refreshTokens(pair.refreshToken, clientId), null);
    } finally {
      await a.cleanup();
    }
  },
);

// ── Pure ──────────────────────────────────────────────────────────────────

Deno.test("jsonSchemaToZod: required, optional, strict objects, bounds and enums", () => {
  const shape = objectShape({
    type: "object",
    properties: {
      id: { type: "string", format: "uuid" },
      limit: { type: "integer", minimum: 1, maximum: 10 },
      kind: { type: "string", enum: ["a", "b"] },
    },
    required: ["id"],
  });
  const schema = jsonSchemaToZod({
    type: "object",
    properties: {
      id: { type: "string", format: "uuid" },
      limit: { type: "integer", minimum: 1, maximum: 10 },
      kind: { type: "string", enum: ["a", "b"] },
    },
    required: ["id"],
  });
  const id = crypto.randomUUID();
  assert(schema.safeParse({ id }).success);
  assert(schema.safeParse({ id, limit: 3, kind: "a" }).success);
  assert(!schema.safeParse({}).success, "id is required");
  assert(!schema.safeParse({ id, limit: 11 }).success, "maximum");
  assert(!schema.safeParse({ id, limit: 1.5 }).success, "integer");
  assert(!schema.safeParse({ id, kind: "c" }).success, "enum");
  assert(!schema.safeParse({ id, organizationId: "x" }).success, "strict by default");
  assert(shape.limit.isOptional());
  assert(!shape.id.isOptional());
});

Deno.test("scopeAllows: reads need tools:read, writes need tools:write", () => {
  const read = { write: false } as AgentTool;
  const write = { write: true } as AgentTool;
  assert(scopeAllows(read, ["tools:read"]));
  assert(!scopeAllows(write, ["tools:read"]));
  assert(scopeAllows(write, ["tools:read", "tools:write"]));
  assert(!scopeAllows(read, []));
});
