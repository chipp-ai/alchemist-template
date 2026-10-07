/**
 * The MCP feature end to end, through the real app.ts mounts, with the
 * feature switched on for this test worker only (setFeatureForTests).
 *
 *   discovery documents -> dynamic client registration (RFC 7591)
 *   -> mint an mcp_sk_ key from a browser session
 *   -> the credit-priced example tool without credits: a tool error that
 *      names the missing credits, and the balance is untouched
 *   -> the same call after a grant: the caller's own team summary, one
 *      credit spent
 *
 * Plus the example tools registry smoke checks the old pack shipped.
 */
import { assert, assertEquals, assertExists, assertStringIncludes } from "@std/assert";
import { z } from "zod";
import { app } from "../../../app.ts";
import { createIsolatedUser } from "../helpers.ts";
import { createSessionToken } from "@/api/middleware/auth.ts";
import { setFeatureForTests } from "@/lib/features.ts";
import { creditService } from "@/services/credit.service.ts";
import { listMcpTools, registerMcpTool } from "@/mcp/registry.ts";
// The example tools register themselves when server.ts imports them.
import "@/mcp/server.ts";
import { getEnv } from "@/lib/env.ts";

const HAS_DB = !!(getEnv("TEST_DATABASE_URL") || getEnv("DATABASE_URL"));

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
      }
    },
  });
}

/** One JSON-RPC call to /api/mcp. The transport may answer as JSON or as one SSE event. */
async function rpc(method: string, params: unknown, bearer?: string) {
  const res = await app.request("/api/mcp", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  assertEquals(res.status, 200, await res.clone().text());
  const text = await res.text();
  const json = text.trimStart().startsWith("{")
    ? text
    : text.split("\n").find((l) => l.startsWith("data: "))!.slice("data: ".length);
  return JSON.parse(json);
}

dbTest("mcp feature: discovery, client registration, and a priced tool call without and with credits", async () => {
  const meta = await (await app.request("/.well-known/oauth-authorization-server")).json();
  assertStringIncludes(meta.registration_endpoint, "/api/mcp/oauth/register");
  assertEquals(meta.code_challenge_methods_supported, ["S256"]);

  const reg = await app.request("/api/mcp/oauth/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ client_name: "test client", redirect_uris: ["http://localhost:9999/cb"] }),
  });
  assertEquals(reg.status, 201, await reg.clone().text());
  assertExists((await reg.json()).client_id);

  const { user, cleanup } = await createIsolatedUser("owner");
  try {
    const cookie = `session_id=${await createSessionToken(user)}`;
    const minted = await app.request("/api/mcp/api-keys", {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ name: "test mcp key" }),
    });
    assertEquals(minted.status, 201, await minted.clone().text());
    const key = (await minted.json()).data.key.key as string;
    assert(key.startsWith("mcp_sk_"));

    const tools = await rpc("tools/list", {}, key);
    assert(tools.result.tools.some((t: { name: string }) => t.name === "get_team_summary"));

    const broke = await rpc("tools/call", { name: "get_team_summary", arguments: {} }, key);
    assertEquals(broke.result.isError, true);
    assertStringIncludes(broke.result.content[0].text, "Insufficient credits");
    assertEquals(await creditService.getBalance(user.organizationId), 0n);

    await creditService.grant({ organizationId: user.organizationId, amount: 2, reason: "test_grant" });
    const paid = await rpc("tools/call", { name: "get_team_summary", arguments: {} }, key);
    assertEquals(paid.result.isError ?? false, false);
    assertEquals(JSON.parse(paid.result.content[0].text).teamSize, 1);
    assertEquals(await creditService.getBalance(user.organizationId), 1n);
  } finally {
    await cleanup();
  }
});

Deno.test("mcp registry: a duplicate tool name is rejected", () => {
  const tool = {
    name: "__test_dup_tool__",
    description: "test",
    inputSchema: {},
    handler: () => Promise.resolve({ content: [{ type: "text" as const, text: "ok" }] }),
  };
  registerMcpTool(tool);
  let threw = false;
  try {
    registerMcpTool(tool);
  } catch {
    threw = true;
  }
  assertEquals(threw, true);
});

Deno.test("mcp registry: price and creditCost on one tool are rejected", () => {
  let threw = false;
  try {
    registerMcpTool({
      name: "__test_conflict_tool__",
      description: "test",
      inputSchema: { x: z.string() },
      price: { fiatUsd: "0.10", cryptoUsd: "0.01", description: "x" },
      creditCost: 1,
      handler: () => Promise.resolve({ content: [{ type: "text" as const, text: "ok" }] }),
    });
  } catch {
    threw = true;
  }
  assertEquals(threw, true);
});

Deno.test("mcp registry: the example tools are registered", () => {
  const names = listMcpTools().map((t) => t.name);
  assertExists(names.find((n) => n === "echo"));
  assertExists(names.find((n) => n === "get_team_summary"));
});
