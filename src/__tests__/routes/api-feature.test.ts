/**
 * The API feature end to end, through the real app.ts mounts, with the
 * feature switched on for this test worker only (setFeatureForTests).
 *
 *   mint an api_sk_ key from a browser session
 *   -> no key: 401
 *   -> key, zero credits: 402 INSUFFICIENT_CREDITS (and the balance is untouched)
 *   -> key, credits granted: 200, one credit spent
 *   -> revoked key: 401
 *
 * Also pins that the two key kinds (api_sk_ here, mcp_sk_ for the MCP
 * feature) never list, revoke or authenticate as each other.
 */
import { assertEquals, assertExists } from "@std/assert";
import { app } from "../../../app.ts";
import { createIsolatedUser } from "../helpers.ts";
import { createSessionToken } from "@/api/middleware/auth.ts";
import { setFeatureForTests } from "@/lib/features.ts";
import { creditService } from "@/services/credit.service.ts";
import { mcpApiKeyService } from "@/services/mcp-oauth/api-key.service.ts";
import { getEnv } from "@/lib/env.ts";

const HAS_DB = !!(getEnv("TEST_DATABASE_URL") || getEnv("DATABASE_URL"));

function dbTest(name: string, fn: () => Promise<void>) {
  Deno.test({
    name,
    ignore: !HAS_DB,
    sanitizeResources: false,
    sanitizeOps: false,
    fn: async () => {
      setFeatureForTests("api", true);
      try {
        await fn();
      } finally {
        setFeatureForTests("api", null);
      }
    },
  });
}

async function sessionCookie(user: Parameters<typeof createSessionToken>[0]): Promise<string> {
  return `session_id=${await createSessionToken(user)}`;
}

async function mintKey(cookie: string): Promise<{ id: string; key: string }> {
  const res = await app.request("/api/api-keys", {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ name: "test key" }),
  });
  assertEquals(res.status, 201, await res.clone().text());
  const body = await res.json();
  return { id: body.data.key.id, key: body.data.key.key };
}

dbTest("api feature: key mint, then 401 / 402 / 200 on the priced example route", async () => {
  const { user, cleanup } = await createIsolatedUser("owner");
  try {
    const cookie = await sessionCookie(user);
    const { key } = await mintKey(cookie);
    assertEquals(key.startsWith("api_sk_"), true);

    const noKey = await app.request("/api/v1/team-summary");
    assertEquals(noKey.status, 401);
    await noKey.body?.cancel();

    const broke = await app.request("/api/v1/team-summary", { headers: { authorization: `Bearer ${key}` } });
    assertEquals(broke.status, 402);
    assertEquals((await broke.json()).code, "INSUFFICIENT_CREDITS");
    assertEquals(await creditService.getBalance(user.organizationId), 0n);

    await creditService.grant({ organizationId: user.organizationId, amount: 3, reason: "test_grant" });
    const paid = await app.request("/api/v1/team-summary", { headers: { authorization: `Bearer ${key}` } });
    assertEquals(paid.status, 200);
    assertEquals((await paid.json()).data.teamSize, 1);
    assertEquals(await creditService.getBalance(user.organizationId), 2n);
  } finally {
    await cleanup();
  }
});

dbTest("api feature: a revoked key stops working, and mint/list refuse a bearer key", async () => {
  const { user, cleanup } = await createIsolatedUser("owner");
  try {
    const cookie = await sessionCookie(user);
    const { id, key } = await mintKey(cookie);

    // Account management is session-only: a leaked key cannot mint more keys.
    const viaKey = await app.request("/api/api-keys", { headers: { authorization: `Bearer ${key}` } });
    assertEquals(viaKey.status, 401);
    await viaKey.body?.cancel();

    const del = await app.request(`/api/api-keys/${id}`, { method: "DELETE", headers: { cookie } });
    assertEquals(del.status, 200);
    await del.body?.cancel();
    const after = await app.request("/api/v1/team-summary", { headers: { authorization: `Bearer ${key}` } });
    assertEquals(after.status, 401);
    await after.body?.cancel();
  } finally {
    await cleanup();
  }
});

dbTest("api and mcp keys stay separate: each surface lists and revokes only its own kind", async () => {
  const { user, cleanup } = await createIsolatedUser("owner");
  try {
    const cookie = await sessionCookie(user);
    const apiKey = await mintKey(cookie);
    const mcpKey = await mcpApiKeyService.mint({ userId: user.id, name: "mcp key" });

    const list = await app.request("/api/api-keys", { headers: { cookie } });
    const listed = (await list.json()).data.keys as Array<{ id: string; keyPrefix: string }>;
    assertEquals(listed.map((k) => k.id), [apiKey.id]);

    // An mcp_sk_ key is not an API key.
    const wrongKind = await app.request("/api/v1/team-summary", {
      headers: { authorization: `Bearer ${mcpKey.key}` },
    });
    assertEquals(wrongKind.status, 401);
    await wrongKind.body?.cancel();

    // Revoking the MCP key through the API surface is a no-op.
    const del = await app.request(`/api/api-keys/${mcpKey.id}`, { method: "DELETE", headers: { cookie } });
    await del.body?.cancel();
    assertExists(await mcpApiKeyService.verify(mcpKey.key));
  } finally {
    await cleanup();
  }
});
