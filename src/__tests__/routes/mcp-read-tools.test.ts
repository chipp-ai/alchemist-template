// deno-lint-ignore-file no-explicit-any
/**
 * The generic MCP read tools every project gets (src/mcp/tools/project_files.ts,
 * src/mcp/tools/project_data.ts), through the real app.ts mount.
 *
 * What it must guarantee:
 *   - an OAuth-connected VIEWER can list and call the read tools, which are
 *     advertised read-only, and cannot see or call a write tool
 *   - a portal viewer and an anonymous caller get nothing from them
 *   - the data model leaves out auth and secret tables and columns
 *   - query_data is pinned to the caller's organization, refuses hidden,
 *     forbidden and org-less tables and unknown columns, binds filter values
 *     as data, and caps the rows
 *   - documents are org-scoped, text comes back as text, and every file has
 *     an absolute download URL
 */

import { assert, assertEquals, assertExists, assertStringIncludes } from "@std/assert";
import { app } from "../../../app.ts";
import { createIsolatedUser } from "../helpers.ts";
import { setFeatureForTests } from "@/lib/features.ts";
import { __deleteEnvForTest, __setEnvForTest, getEnv } from "@/lib/env.ts";
import { clientService, oauthTokenService } from "@/services/mcp-oauth/service.ts";
import { db } from "@/db/client.ts";
import { registerAgentTool } from "@/services/agent-tools/registry.ts";
import { storeUploadedFile } from "@/services/uploaded-file.service.ts";
import { HIDDEN_COLUMN_PATTERN, MAX_QUERY_ROWS } from "@/services/mcp-data/data-access.ts";
import "@/mcp/server.ts";

const HAS_DB = !!(getEnv("TEST_DATABASE_URL") || getEnv("DATABASE_URL"));
const READ_TOOLS = ["list_documents", "read_document", "describe_data_model", "query_data"];

// A test-only write tool at the editor level, so the viewer check is real.
const WRITE_TOOL = "read_tools_test_write";
let writeRuns = 0;
registerAgentTool({
  name: WRITE_TOOL,
  description: "test only",
  inputSchema: { type: "object", properties: {} },
  capability: "app.write",
  write: true,
  handler: () => {
    writeRuns++;
    return { ok: true };
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
      __setEnvForTest("MCP_AUTH_MODE", "oauth");
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

async function tools(bearer?: string): Promise<any[]> {
  return (await rpc("tools/list", {}, bearer)).result.tools;
}

async function call(
  bearer: string,
  name: string,
  args: Record<string, unknown> = {},
): Promise<any> {
  return await rpc("tools/call", { name, arguments: args }, bearer);
}

/** The JSON a successful read tool returned. */
function data(reply: any): any {
  assert(!reply.error && !reply.result?.isError, JSON.stringify(reply));
  return JSON.parse(reply.result.content[0].text);
}

function refusalText(reply: any): string {
  if (reply.error) return String(reply.error.message);
  assert(reply.result?.isError === true, `expected a refusal, got ${JSON.stringify(reply)}`);
  return reply.result.content.map((c: any) => c.text).join("\n");
}

async function oauthToken(userId: string, scopes = ["tools:write"]): Promise<string> {
  const { clientId } = await clientService.register({
    redirectUris: ["http://localhost:9999/cb"],
    clientName: "read tools test",
  });
  return (await oauthTokenService.issueTokens({ userId, clientId, scopes })).accessToken;
}

async function addMember(organizationId: string, role: "viewer" | "editor"): Promise<string> {
  const row = await db
    .insertInto("users")
    .values({
      email: `member-${crypto.randomUUID()}@mcp-read-tools.test.local`,
      name: "Member",
      role,
      organizationId,
      emailVerified: true,
    })
    .returning(["id"])
    .executeTakeFirstOrThrow();
  return row.id;
}

async function storeCsv(organizationId: string, name: string, body: string) {
  return await storeUploadedFile({
    organizationId,
    uploadedByUserId: null,
    filename: name,
    contentType: "text/csv",
    body: new TextEncoder().encode(body),
    status: "approved",
  });
}

dbTest(
  "mcp read tools: an OAuth viewer sees and calls the read tools, never a write tool",
  async () => {
    const org = await createIsolatedUser("owner");
    try {
      const viewer = await oauthToken(await addMember(org.org.id, "viewer"));
      const listed = await tools(viewer);
      const names = listed.map((t) => t.name);
      for (const name of READ_TOOLS) {
        assert(names.includes(name), `${name} missing: ${names.join(", ")}`);
        const tool = listed.find((t) => t.name === name);
        assertEquals(tool.annotations?.readOnlyHint, true);
      }
      assert(!names.includes(WRITE_TOOL), names.join(", "));

      data(await call(viewer, "describe_data_model"));
      data(await call(viewer, "list_documents"));
      data(await call(viewer, "query_data", { table: "uploaded_files" }));

      const before = writeRuns;
      refusalText(await call(viewer, WRITE_TOOL));
      assertEquals(writeRuns, before);

      // The control: an editor does get the write tool.
      const editor = await oauthToken(await addMember(org.org.id, "editor"));
      assert((await tools(editor)).some((t) => t.name === WRITE_TOOL));
    } finally {
      await org.cleanup();
    }
  },
);

dbTest("mcp read tools: a portal viewer gets none of them", async () => {
  const org = await createIsolatedUser("owner");
  try {
    const id = await addMember(org.org.id, "viewer");
    await db.insertInto("portal_access_tokens").values({
      organizationId: org.org.id,
      userId: id,
      email: `portal-${id}@mcp-read-tools.test.local`,
      subjectType: "project",
      subjectId: "p-1",
      tokenHash: crypto.randomUUID(),
    }).execute();
    const names = (await tools(await oauthToken(id))).map((t) => t.name);
    for (const name of READ_TOOLS) {
      assert(!names.includes(name), `${name} listed for a portal viewer`);
    }
  } finally {
    await org.cleanup();
  }
});

dbTest("mcp read tools: an anonymous caller in public mode is asked to sign in", async () => {
  __setEnvForTest("MCP_AUTH_MODE", "public");
  const reply = await rpc("tools/call", {
    name: "query_data",
    arguments: { table: "uploaded_files" },
  });
  assertStringIncludes(refusalText(reply).toLowerCase(), "sign");
});

dbTest("mcp read tools: the data model leaves out auth and secret tables and columns", async () => {
  const org = await createIsolatedUser("owner");
  try {
    const viewer = await oauthToken(await addMember(org.org.id, "viewer"));
    const model = data(await call(viewer, "describe_data_model"));
    const tables = new Map<string, any>(model.tables.map((t: any) => [t.table, t]));
    for (
      const hidden of [
        "users",
        "otps",
        "sessions",
        "api_credentials",
        "invites",
        "portal_access_tokens",
        "verification_sessions",
        "mcp_oauth_tokens",
        "mcp_oauth_clients",
        "mcp_oauth_auth_codes",
        "platform_member_sync_state",
        "events",
        "email_outbox",
      ]
    ) {
      assert(!tables.has(hidden), `${hidden} is exposed`);
    }
    // Billing tables need billing.manage: hidden from a viewer.
    assert(!tables.has("credit_ledger_entries"));
    for (const t of tables.values()) {
      for (const c of t.columns) {
        assert(!HIDDEN_COLUMN_PATTERN.test(c.name), `${t.table}.${c.name}`);
      }
    }
    const files = tables.get("uploaded_files");
    assertExists(files);
    assertEquals(files.queryable, true);
    assert(files.columns.some((c: any) => c.name === "filename"));
    assertEquals(tables.get("products")?.queryable, false);

    // The owner sees the billing tables.
    const owner = await oauthToken(org.user.id);
    const ownerTables = data(await call(owner, "describe_data_model")).tables.map((t: any) =>
      t.table
    );
    assert(ownerTables.includes("credit_ledger_entries"));
  } finally {
    await org.cleanup();
  }
});

dbTest(
  "mcp read tools: query_data is pinned to the caller's org and refuses what it must",
  async () => {
    const a = await createIsolatedUser("owner");
    const b = await createIsolatedUser("owner");
    try {
      await storeCsv(a.org.id, "a-report.csv", "x,y\n1,2\n");
      await storeCsv(a.org.id, "a-other.csv", "x\n3\n");
      const bFile = await storeCsv(b.org.id, "b-secret.csv", "z\n9\n");
      const viewer = await oauthToken(await addMember(a.org.id, "viewer"));

      const all = data(
        await call(viewer, "query_data", { table: "uploaded_files", columns: ["id", "filename"] }),
      );
      assertEquals(all.rows.length, 2);
      assert(all.rows.every((r: any) => r.filename.startsWith("a-")));

      // Another org's id through a filter is simply no rows.
      const cross = data(
        await call(viewer, "query_data", {
          table: "uploaded_files",
          filters: [{ column: "id", op: "eq", value: bFile.id }],
        }),
      );
      assertEquals(cross.rows.length, 0);

      // Filter values are data, never SQL.
      const injected = data(
        await call(viewer, "query_data", {
          table: "uploaded_files",
          filters: [{ column: "filename", op: "eq", value: "x' OR '1'='1" }],
        }),
      );
      assertEquals(injected.rows.length, 0);

      const filtered = data(
        await call(viewer, "query_data", {
          table: "uploaded_files",
          columns: ["filename"],
          filters: [{ column: "filename", op: "ilike", value: "%REPORT%" }],
          orderBy: { column: "filename", direction: "desc" },
        }),
      );
      assertEquals(filtered.rows, [{ filename: "a-report.csv" }]);

      const capped = data(await call(viewer, "query_data", { table: "uploaded_files", limit: 1 }));
      assertEquals(capped.rows.length, 1);
      assertEquals(capped.truncated, true);
      refusalText(
        await call(viewer, "query_data", { table: "uploaded_files", limit: MAX_QUERY_ROWS + 1 }),
      );

      assertStringIncludes(
        refusalText(await call(viewer, "query_data", { table: "users" })),
        "not found",
      );
      assertStringIncludes(
        refusalText(await call(viewer, "query_data", { table: "mcp_oauth_tokens" })),
        "not found",
      );
      assertStringIncludes(
        refusalText(await call(viewer, "query_data", { table: "credit_ledger_entries" })),
        "not found",
      );
      assertStringIncludes(
        refusalText(await call(viewer, "query_data", { table: "products" })),
        "organization_id",
      );
      assertStringIncludes(
        refusalText(
          await call(viewer, "query_data", { table: "uploaded_files", columns: ["nope"] }),
        ),
        "Unknown column",
      );
    } finally {
      await a.cleanup();
      await b.cleanup();
    }
  },
);

dbTest(
  "mcp read tools: documents are org-scoped, text is inlined, and the URL is absolute",
  async () => {
    const a = await createIsolatedUser("owner");
    const b = await createIsolatedUser("owner");
    try {
      const mine = await storeCsv(a.org.id, "numbers.csv", "n\n42\n");
      const theirs = await storeCsv(b.org.id, "theirs.csv", "n\n7\n");
      const viewer = await oauthToken(await addMember(a.org.id, "viewer"));

      const listed = data(await call(viewer, "list_documents", { query: "numbers" }));
      assertEquals(listed.documents.map((d: any) => d.id), [mine.id]);

      const read = data(await call(viewer, "read_document", { id: mine.id }));
      assertEquals(read.text, "n\n42\n");
      assert(/^https?:\/\//.test(read.downloadUrl), read.downloadUrl);

      assertStringIncludes(
        refusalText(await call(viewer, "read_document", { id: theirs.id })),
        "not found",
      );
    } finally {
      await a.cleanup();
      await b.cleanup();
    }
  },
);
