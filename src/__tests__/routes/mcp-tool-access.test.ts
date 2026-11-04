// deno-lint-ignore-file no-explicit-any
/**
 * Who may list and call a registerMcpTool tool that declares a capability,
 * through the real app.ts mount (src/mcp/server.ts).
 *
 * Why this exists: createMcpServer registered every registry tool for every
 * caller, so get_team_summary (team size, role breakdown, latest signup) ran
 * for a portal viewer, and each call spent one of the org's credits.
 *
 * What it must guarantee:
 *   - a portal viewer does not see get_team_summary, cannot call it, and the
 *     call spends no credit
 *   - a viewer who is an ordinary member can use it (same rule as the
 *     list_team_members agent tool)
 *   - a capability above the caller's role hides the tool; a demotion applies
 *     on the next request
 *   - an anonymous caller in public mode sees a capability tool but its
 *     handler never runs
 *   - a tool that declares no capability (echo) stays open to a signed-in
 *     caller
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { app } from "../../../app.ts";
import { createIsolatedUser } from "../helpers.ts";
import { setFeatureForTests } from "@/lib/features.ts";
import { __deleteEnvForTest, __setEnvForTest, getEnv } from "@/lib/env.ts";
import { clientService, oauthTokenService } from "@/services/mcp-oauth/service.ts";
import { creditService } from "@/services/credit.service.ts";
import { db } from "@/db/client.ts";
import { registerMcpTool } from "@/mcp/registry.ts";
import "@/mcp/server.ts";

const HAS_DB = !!(getEnv("TEST_DATABASE_URL") || getEnv("DATABASE_URL"));

const ADMIN_TOOL = "__test_admin_only_mcp_tool__";
let adminToolRuns = 0;
registerMcpTool({
  name: ADMIN_TOOL,
  description: "test only",
  inputSchema: {},
  capability: "team.invite",
  handler: () => {
    adminToolRuns++;
    return Promise.resolve({ content: [{ type: "text" as const, text: "ran" }] });
  },
});

function dbTest(name: string, fn: () => Promise<void>) {
  Deno.test({
    name,
    ignore: !HAS_DB,
    sanitizeResources: false,
    sanitizeOps: false,
    fn: async () => {
      setFeatureForTests("mcp", true);
      try {
        await fn();
      } finally {
        setFeatureForTests("mcp", null);
        __deleteEnvForTest("MCP_AUTH_MODE");
      }
    },
  });
}

let rpcId = 0;
async function rpc(method: string, params: unknown, bearer?: string): Promise<any> {
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
  assertEquals(res.status, 200, text);
  const json = text.trimStart().startsWith("{")
    ? text
    : text.split("\n").find((l) => l.startsWith("data: "))!.slice("data: ".length);
  return JSON.parse(json);
}

async function toolNames(bearer?: string): Promise<string[]> {
  return (await rpc("tools/list", {}, bearer)).result.tools.map((t: any) => t.name);
}

async function oauthToken(userId: string): Promise<string> {
  const { clientId } = await clientService.register({
    redirectUris: ["http://localhost:9999/cb"],
    clientName: "tool access test",
  });
  return (await oauthTokenService.issueTokens({ userId, clientId, scopes: ["tools:write"] })).accessToken;
}

/** A refused call: an error either way, and never the tool's output. */
function assertRefused(reply: any) {
  const refused = reply.error !== undefined || reply.result?.isError === true;
  assert(refused, `expected a refusal, got ${JSON.stringify(reply)}`);
}

async function addMember(organizationId: string, role: "viewer" | "editor"): Promise<string> {
  const row = await db
    .insertInto("users")
    .values({
      email: `member-${crypto.randomUUID()}@mcp-tool-access.test.local`,
      name: "Member",
      role,
      organizationId,
      emailVerified: true,
    })
    .returning(["id"])
    .executeTakeFirstOrThrow();
  return row.id;
}

async function addPortalViewer(organizationId: string): Promise<string> {
  const id = await addMember(organizationId, "viewer");
  await db.insertInto("portal_access_tokens").values({
    organizationId,
    userId: id,
    email: `portal-${id}@mcp-tool-access.test.local`,
    subjectType: "project",
    subjectId: "project-42",
    tokenHash: crypto.randomUUID(),
  }).execute();
  return id;
}

dbTest("mcp tool access: a portal viewer cannot see or call get_team_summary, and spends no credit", async () => {
  __setEnvForTest("MCP_AUTH_MODE", "oauth");
  const org = await createIsolatedUser("owner");
  try {
    await creditService.grant({ organizationId: org.org.id, amount: 5, reason: "test_grant" });
    const token = await oauthToken(await addPortalViewer(org.org.id));

    const names = await toolNames(token);
    assert(!names.includes("get_team_summary"), names.join(", "));
    assert(names.includes("echo"), "a tool with no capability stays listed");

    assertRefused(await rpc("tools/call", { name: "get_team_summary", arguments: {} }, token));
    assertEquals(await creditService.getBalance(org.org.id), 5n);
  } finally {
    await org.cleanup();
  }
});

dbTest("mcp tool access: an ordinary viewer can use get_team_summary", async () => {
  __setEnvForTest("MCP_AUTH_MODE", "oauth");
  const org = await createIsolatedUser("owner");
  try {
    await creditService.grant({ organizationId: org.org.id, amount: 5, reason: "test_grant" });
    const token = await oauthToken(await addMember(org.org.id, "viewer"));

    assert((await toolNames(token)).includes("get_team_summary"));
    const reply = await rpc("tools/call", { name: "get_team_summary", arguments: {} }, token);
    assertEquals(reply.result.isError ?? false, false, JSON.stringify(reply));
    assertEquals(JSON.parse(reply.result.content[0].text).teamSize, 2);
    assertEquals(await creditService.getBalance(org.org.id), 4n);
  } finally {
    await org.cleanup();
  }
});

dbTest("mcp tool access: a capability above the role hides the tool, and a demotion applies at once", async () => {
  __setEnvForTest("MCP_AUTH_MODE", "oauth");
  const org = await createIsolatedUser("owner");
  try {
    const ownerToken = await oauthToken(org.user.id);
    const runsBefore = adminToolRuns;
    assert((await toolNames(ownerToken)).includes(ADMIN_TOOL));
    const ran = await rpc("tools/call", { name: ADMIN_TOOL, arguments: {} }, ownerToken);
    assertEquals(ran.result.content[0].text, "ran");
    assertEquals(adminToolRuns, runsBefore + 1);

    const editorId = await addMember(org.org.id, "editor");
    const editorToken = await oauthToken(editorId);
    assert(!(await toolNames(editorToken)).includes(ADMIN_TOOL));
    assertRefused(await rpc("tools/call", { name: ADMIN_TOOL, arguments: {} }, editorToken));
    assertEquals(adminToolRuns, runsBefore + 1, "the handler must not run for an editor");

    await db.updateTable("users").set({ role: "editor" }).where("id", "=", org.user.id).execute();
    assert(!(await toolNames(ownerToken)).includes(ADMIN_TOOL), "demoted on the next request");
  } finally {
    await org.cleanup();
  }
});

dbTest("mcp tool access: an anonymous caller in public mode sees the tool, but it asks them to sign in", async () => {
  const runsBefore = adminToolRuns;
  assert((await toolNames()).includes(ADMIN_TOOL), "listed, so the client knows to connect");
  const reply = await rpc("tools/call", { name: ADMIN_TOOL, arguments: {} });
  assertEquals(reply.result.isError, true);
  assertStringIncludes(reply.result.content[0].text, "signed-in account");
  assertEquals(adminToolRuns, runsBefore, "the handler must not run for an anonymous caller");

  const summary = await rpc("tools/call", { name: "get_team_summary", arguments: {} });
  assertEquals(summary.result.isError, true);
  assertStringIncludes(summary.result.content[0].text, "signed-in account");
});
