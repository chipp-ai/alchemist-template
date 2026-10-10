// deno-lint-ignore-file no-explicit-any
/**
 * POST /api/agent-mcp through the real app.ts mount.
 *
 * What it must guarantee:
 *   - only a bearer agent token gets in: no session cookie, no session JWT,
 *     no WS token; and an agent token is never a session cookie
 *   - the user is re-read per request: current role, current org,
 *     logout-all
 *   - tools/list shows only what the user's role allows; a hidden tool is
 *     "unknown" on tools/call
 *   - a user of org A cannot reach org B's rows through any starter tool,
 *     even when the model passes B's ids
 *   - a portal viewer sees only portal-safe tools
 *   - write tools carry destructiveHint + chipp/requiresConfirmation
 *   - no CORS headers on this path
 */

import { assert, assertEquals, assertExists } from "@std/assert";
import { app } from "../../../app.ts";
import { createIsolatedUser, type IsolatedTestContext } from "../helpers.ts";
import { createSessionToken, createWsToken } from "@/api/middleware/auth.ts";
import { mintAgentToken } from "@/services/agent-tools/agent-token.ts";
import { registerAgentTool, REQUIRES_CONFIRMATION_META } from "@/services/agent-tools/registry.ts";
import { db } from "@/db/client.ts";
import { getEnv } from "@/lib/env.ts";

const HAS_DB = !!(getEnv("TEST_DATABASE_URL") || getEnv("DATABASE_URL"));
// Agent tokens need JWT_SECRET (no development fallback). CI sets it.
const HAS_SECRET = !!getEnv("JWT_SECRET");

function dbTest(name: string, fn: () => Promise<void>) {
  Deno.test({
    name,
    ignore: !HAS_DB || !HAS_SECRET,
    sanitizeResources: false,
    sanitizeOps: false,
    fn,
  });
}

const URL_PATH = "/api/agent-mcp";

// Test-only tools above app.read, so role filtering is visible.
registerAgentTool({
  name: "test_editor_tool",
  description: "test only",
  inputSchema: { type: "object", properties: {} },
  capability: "app.write",
  write: true,
  handler: () => ({ ok: true }),
});
registerAgentTool({
  name: "test_admin_tool",
  description: "test only",
  inputSchema: { type: "object", properties: {} },
  capability: "team.invite",
  write: false,
  handler: () => ({ ok: true }),
});

type U = IsolatedTestContext["user"];

let rpcId = 0;
async function rpc(
  auth: string | null,
  method: string,
  params?: unknown,
  extraHeaders: Record<string, string> = {},
): Promise<{ status: number; body: any; res: Response }> {
  const res = await app.request(URL_PATH, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(auth ? { authorization: auth } : {}),
      ...extraHeaders,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null, res };
}

async function bearer(user: U): Promise<string> {
  return `Bearer ${await mintAgentToken(user)}`;
}

async function toolNames(auth: string): Promise<string[]> {
  const { status, body } = await rpc(auth, "tools/list");
  assertEquals(status, 200);
  return body.result.tools.map((t: { name: string }) => t.name).sort();
}

async function call(auth: string, name: string, args: unknown = {}) {
  const { status, body } = await rpc(auth, "tools/call", { name, arguments: args });
  assertEquals(status, 200);
  return body;
}

async function insertFile(
  orgId: string,
  uploadedBy: string,
  filename: string,
  status = "approved",
) {
  return await db
    .insertInto("uploaded_files")
    .values({
      organizationId: orgId,
      uploadedBy,
      storageKey: `uploads/${orgId}/${crypto.randomUUID()}.pdf`,
      filename,
      contentType: "application/pdf",
      sizeBytes: 10,
      status: status as "approved",
    })
    .returning(["id"])
    .executeTakeFirstOrThrow();
}

const STARTER_ALL = [
  "get_current_user",
  "get_file",
  "list_files",
  "list_my_portal_records",
  "list_team_members",
  "update_my_profile",
];

// ── Auth ──────────────────────────────────────────────────────────────────

dbTest("agent-mcp auth: only a bearer agent token gets in", async () => {
  const a = await createIsolatedUser("owner");
  try {
    const session = await createSessionToken(a.user);
    const ws = await createWsToken(a.user);

    assertEquals((await rpc(null, "tools/list")).status, 401, "no credentials");
    const cookieOnly = await rpc(null, "tools/list", undefined, {
      cookie: `session_id=${session}`,
    });
    assertEquals(cookieOnly.status, 401, "a session cookie is not accepted");
    assertEquals(
      (await rpc(`Bearer ${session}`, "tools/list")).status,
      401,
      "a session JWT as bearer",
    );
    assertEquals((await rpc(`Bearer ${ws}`, "tools/list")).status, 401, "a WS token as bearer");
    assertEquals((await rpc("Bearer not-a-token", "tools/list")).status, 401);
    const bad = await rpc("Bearer not-a-token", "tools/list");
    assert(bad.res.headers.get("www-authenticate")?.includes("invalid_token"));

    const ok = await rpc(await bearer(a.user), "tools/list");
    assertEquals(ok.status, 200);
  } finally {
    await a.cleanup();
  }
});

dbTest("agent-mcp auth: an agent token is never a session cookie", async () => {
  const a = await createIsolatedUser("owner");
  try {
    const agentToken = await mintAgentToken(a.user);
    const asCookie = await app.request("/api/auth/me", {
      headers: { cookie: `session_id=${agentToken}` },
    });
    assertEquals(asCookie.status, 401);
    await asCookie.body?.cancel();

    // The control: the same user's real session works, so the 401 above is
    // the scope check, not a missing user.
    const session = await createSessionToken(a.user);
    const real = await app.request("/api/auth/me", {
      headers: { cookie: `session_id=${session}` },
    });
    assertEquals(real.status, 200);
    await real.body?.cancel();
  } finally {
    await a.cleanup();
  }
});

dbTest("agent-mcp auth: logout-all revokes agent tokens minted before it", async () => {
  const a = await createIsolatedUser("editor");
  try {
    const auth = await bearer(a.user);
    assertEquals((await rpc(auth, "tools/list")).status, 200);

    // logout-all compares whole seconds; step past the token's iat second.
    await new Promise((r) => setTimeout(r, 1100));
    const session = await createSessionToken(a.user);
    const out = await app.request("/api/auth/logout-all", {
      method: "POST",
      headers: { cookie: `session_id=${session}` },
    });
    assertEquals(out.status, 200);
    await out.body?.cancel();

    assertEquals((await rpc(auth, "tools/list")).status, 401);
  } finally {
    await a.cleanup();
  }
});

dbTest("agent-mcp auth: current role and org apply, not the token's", async () => {
  const a = await createIsolatedUser("admin");
  const b = await createIsolatedUser("owner");
  try {
    const auth = await bearer(a.user);
    assert((await toolNames(auth)).includes("test_admin_tool"));

    await db.updateTable("users").set({ role: "viewer" }).where("id", "=", a.user.id).execute();
    const after = await toolNames(auth);
    assert(!after.includes("test_admin_tool"), "a demotion applies to an existing token");
    assert(!after.includes("test_editor_tool"));

    // Moved to another org: the old token must not open the new org.
    await db.updateTable("users").set({ organizationId: b.org.id }).where("id", "=", a.user.id)
      .execute();
    assertEquals((await rpc(auth, "tools/list")).status, 401);

    // Soft-disconnected (organization_id NULL): refused.
    await db.updateTable("users").set({ organizationId: null }).where("id", "=", a.user.id)
      .execute();
    assertEquals((await rpc(auth, "tools/list")).status, 401);
  } finally {
    await db.deleteFrom("users").where("id", "=", a.user.id).execute();
    await a.cleanup();
    await b.cleanup();
  }
});

// ── Protocol ──────────────────────────────────────────────────────────────

dbTest("agent-mcp protocol: initialize, notifications, ping, unknown method, GET", async () => {
  const a = await createIsolatedUser("editor");
  try {
    const auth = await bearer(a.user);
    const init = await rpc(auth, "initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "chipp", version: "1" },
    });
    assertEquals(init.status, 200);
    assertEquals(init.body.jsonrpc, "2.0");
    assertEquals(init.body.result.protocolVersion, "2025-06-18");
    assertExists(init.body.result.capabilities.tools);
    assertExists(init.body.result.serverInfo.name);

    const note = await app.request(URL_PATH, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: auth },
      body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
    });
    assertEquals(note.status, 202);
    await note.body?.cancel();

    assertEquals((await rpc(auth, "ping")).body.result, {});
    assertEquals((await rpc(auth, "resources/list")).body.error.code, -32601);

    const parse = await app.request(URL_PATH, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: auth },
      body: "{not json",
    });
    assertEquals(parse.status, 400);
    assertEquals((await parse.json()).error.code, -32700);

    const get = await app.request(URL_PATH, { method: "GET", headers: { authorization: auth } });
    assertEquals(get.status, 405);
    await get.body?.cancel();
  } finally {
    await a.cleanup();
  }
});

dbTest("agent-mcp: no CORS headers on this path", async () => {
  const a = await createIsolatedUser("editor");
  try {
    const origin = "https://evil.example";
    const res = await rpc(await bearer(a.user), "tools/list", undefined, { origin });
    assertEquals(res.status, 200);
    assertEquals(res.res.headers.get("access-control-allow-origin"), null);
    assertEquals(res.res.headers.get("access-control-allow-credentials"), null);

    const preflight = await app.request(URL_PATH, {
      method: "OPTIONS",
      headers: { origin, "access-control-request-method": "POST" },
    });
    assertEquals(preflight.headers.get("access-control-allow-origin"), null);
    await preflight.body?.cancel();

    // The control: the rest of the API still answers CORS.
    const other = await app.request("/api/auth/config", { headers: { origin } });
    assertEquals(other.headers.get("access-control-allow-origin"), origin);
    await other.body?.cancel();
  } finally {
    await a.cleanup();
  }
});

// ── tools/list ────────────────────────────────────────────────────────────

dbTest("agent-mcp tools/list: filtered by role, hidden tools are unknown on call", async () => {
  const viewer = await createIsolatedUser("viewer");
  const editor = await createIsolatedUser("editor");
  const admin = await createIsolatedUser("admin");
  try {
    const v = await toolNames(await bearer(viewer.user));
    assertEquals(v, STARTER_ALL);

    const e = await toolNames(await bearer(editor.user));
    assertEquals(e, [...STARTER_ALL, "test_editor_tool"].sort());

    const ad = await toolNames(await bearer(admin.user));
    assertEquals(ad, [...STARTER_ALL, "test_admin_tool", "test_editor_tool"].sort());

    const hidden = await call(await bearer(viewer.user), "test_editor_tool");
    assertEquals(hidden.error.code, -32602);
    const unknown = await call(await bearer(viewer.user), "no_such_tool");
    assertEquals(unknown.error.message, "Unknown tool: no_such_tool");
    assertEquals(
      hidden.error.message,
      "Unknown tool: test_editor_tool",
      "hidden and unknown look the same",
    );
  } finally {
    await viewer.cleanup();
    await editor.cleanup();
    await admin.cleanup();
  }
});

dbTest("agent-mcp tools/list: write tools ask for confirmation, read tools do not", async () => {
  const a = await createIsolatedUser("editor");
  try {
    const { body } = await rpc(await bearer(a.user), "tools/list");
    const byName = new Map<string, any>(body.result.tools.map((t: any) => [t.name, t]));

    const write = byName.get("update_my_profile");
    assertEquals(write.annotations.destructiveHint, true);
    assertEquals(write.annotations.readOnlyHint, false);
    assertEquals(write._meta[REQUIRES_CONFIRMATION_META], true);
    assertEquals(REQUIRES_CONFIRMATION_META, "chipp/requiresConfirmation");
    assertEquals(write.inputSchema.type, "object");

    for (const name of ["get_current_user", "list_files", "get_file", "list_team_members"]) {
      const t = byName.get(name);
      assertEquals(t.annotations.readOnlyHint, true, name);
      assertEquals(t.annotations.destructiveHint, false, name);
      assertEquals(t._meta, undefined, name);
    }
  } finally {
    await a.cleanup();
  }
});

// ── Cross-tenant ──────────────────────────────────────────────────────────

dbTest("agent-mcp cross-tenant: org A cannot read org B through any starter tool", async () => {
  const a = await createIsolatedUser("owner");
  const b = await createIsolatedUser("owner");
  try {
    const fileA = await insertFile(a.org.id, a.user.id, "a-report.pdf");
    const fileB = await insertFile(b.org.id, b.user.id, "b-secret.pdf");
    const auth = await bearer(a.user);

    // get_current_user: A's own identity and org.
    const me = await call(auth, "get_current_user");
    assertEquals(me.result.structuredContent.user.id, a.user.id);
    assertEquals(me.result.structuredContent.organization.id, a.org.id);

    // get_file with B's id: not found, and B's filename never appears.
    const getB = await call(auth, "get_file", { fileId: fileB.id });
    assertEquals(getB.result.isError, true);
    assertEquals(getB.result.structuredContent.code, "NOT_FOUND");
    assert(!JSON.stringify(getB).includes("b-secret.pdf"));
    const getA = await call(auth, "get_file", { fileId: fileA.id });
    assertEquals(getA.result.structuredContent.file.filename, "a-report.pdf");
    assertEquals(
      getA.result.structuredContent.file.storageKey,
      undefined,
      "the storage key stays server-side",
    );

    // list_files: only A's.
    const list = await call(auth, "list_files");
    const names = list.result.structuredContent.files.map((f: { filename: string }) => f.filename);
    assertEquals(names, ["a-report.pdf"]);

    // list_team_members: only A's people.
    const team = await call(auth, "list_team_members");
    const ids = team.result.structuredContent.members.map((m: { id: string }) => m.id);
    assertEquals(ids, [a.user.id]);

    // B's org or user id smuggled into args: refused, never honored.
    for (
      const [tool, args] of [
        ["list_files", { organizationId: b.org.id }],
        ["list_team_members", { organizationId: b.org.id }],
        ["get_current_user", { userId: b.user.id }],
        ["get_file", { fileId: fileB.id, organizationId: b.org.id }],
        ["list_my_portal_records", { userId: b.user.id }],
        ["update_my_profile", { name: "Hacked", userId: b.user.id }],
      ] as const
    ) {
      const res = await call(auth, tool, args);
      assertEquals(res.result.isError, true, `${tool} must refuse foreign ids`);
      assert(!JSON.stringify(res).includes("b-secret.pdf"));
    }

    const bRow = await db.selectFrom("users").select(["name"]).where("id", "=", b.user.id)
      .executeTakeFirstOrThrow();
    assertEquals(bRow.name, b.user.name, "B's profile is untouched");
  } finally {
    await a.cleanup();
    await b.cleanup();
  }
});

dbTest("agent-mcp: update_my_profile renames only the caller", async () => {
  const a = await createIsolatedUser("viewer");
  try {
    const res = await call(await bearer(a.user), "update_my_profile", { name: "  New Name  " });
    assertEquals(res.result.isError, false);
    assertEquals(res.result.structuredContent.user.name, "New Name");
    const row = await db.selectFrom("users").select(["name"]).where("id", "=", a.user.id)
      .executeTakeFirstOrThrow();
    assertEquals(row.name, "New Name");

    const blank = await call(await bearer(a.user), "update_my_profile", { name: "" });
    assertEquals(blank.result.isError, true);
  } finally {
    await a.cleanup();
  }
});

// ── Portal viewers ────────────────────────────────────────────────────────

dbTest("agent-mcp portal viewer: only portal-safe tools, scoped to their bindings", async () => {
  const org = await createIsolatedUser("owner");
  try {
    await insertFile(org.org.id, org.user.id, "org-wide.pdf");
    const portalUser = await db
      .insertInto("users")
      .values({
        email: `portal-${crypto.randomUUID()}@agent-mcp.test.local`,
        name: "Portal Person",
        role: "viewer",
        organizationId: org.org.id,
        emailVerified: true,
      })
      .returning(["id", "email", "name", "role", "organizationId"])
      .executeTakeFirstOrThrow();
    await db.insertInto("portal_access_tokens").values({
      organizationId: org.org.id,
      userId: portalUser.id,
      email: portalUser.email,
      subjectType: "project",
      subjectId: "project-42",
      tokenHash: crypto.randomUUID(),
    }).execute();

    const auth = await bearer({ ...portalUser, organizationId: org.org.id });
    assertEquals(await toolNames(auth), [
      "get_current_user",
      "list_my_portal_records",
      "update_my_profile",
    ]);

    for (const tool of ["list_files", "list_team_members", "get_file"]) {
      const res = await call(
        auth,
        tool,
        tool === "get_file" ? { fileId: crypto.randomUUID() } : {},
      );
      assertEquals(res.error?.code, -32602, `${tool} is unknown to a portal viewer`);
    }

    const records = await call(auth, "list_my_portal_records");
    assertEquals(records.result.structuredContent.records, [{
      subjectType: "project",
      subjectId: "project-42",
    }]);
    const me = await call(auth, "get_current_user");
    assertEquals(me.result.structuredContent.portalUser, true);

    // A plain viewer member (no portal binding) still gets the read tools.
    const member = await createIsolatedUser("viewer");
    try {
      assertEquals(await toolNames(await bearer(member.user)), STARTER_ALL);
    } finally {
      await member.cleanup();
    }
  } finally {
    await org.cleanup();
  }
});
