/**
 * Agent tool registry guards and argument validation (no DB).
 *
 * Registration refuses the shapes that would let the model choose the
 * tenant (org or user id arguments) or run raw queries. The validator
 * refuses unknown arguments, so an org id cannot ride along unnoticed.
 */

import { assertEquals, assertThrows } from "@std/assert";
import {
  __unregisterAgentToolForTest,
  type AgentTool,
  registerAgentTool,
  toolAllowed,
  toolDefinition,
  validateAgentToolArgs,
} from "@/services/agent-tools/registry.ts";
import type { PortalAccess } from "@/services/portal-access.service.ts";
import { BadRequestError } from "@/utils/errors.ts";

function tool(overrides: Partial<AgentTool>): AgentTool {
  return {
    name: "guard_probe",
    description: "test",
    inputSchema: { type: "object", properties: {} },
    capability: "app.read",
    write: false,
    handler: () => null,
    ...overrides,
  };
}

Deno.test("agent tool registry: refuses org and user id arguments", () => {
  for (
    const key of [
      "organizationId",
      "orgId",
      "organization_id",
      "userId",
      "user_id",
      "tenantId",
      "workspaceId",
    ]
  ) {
    assertThrows(
      () =>
        registerAgentTool(tool({
          name: `probe_${key.toLowerCase()}`,
          inputSchema: { type: "object", properties: { [key]: { type: "string" } } },
        })),
      Error,
      "is not allowed",
      key,
    );
  }
});

Deno.test("agent tool registry: refuses raw SQL tools, bad names, non-object schemas, duplicates", () => {
  for (const name of ["run_sql", "sql", "query_database", "execute_query"]) {
    assertThrows(() => registerAgentTool(tool({ name })), Error, "raw SQL", name);
  }
  assertThrows(() => registerAgentTool(tool({ name: "Bad-Name" })), Error, "snake_case");
  assertThrows(
    () => registerAgentTool(tool({ name: "probe_schema", inputSchema: { type: "string" } })),
    Error,
    'must be { type: "object" }',
  );
  registerAgentTool(tool({ name: "probe_dup" }));
  try {
    assertThrows(() => registerAgentTool(tool({ name: "probe_dup" })), Error, "already registered");
  } finally {
    __unregisterAgentToolForTest("probe_dup");
  }
});

Deno.test("agent tool registry: capability and portal filtering", () => {
  const viewer = { id: "u", email: "e", name: null, organizationId: "o", role: "viewer" };
  const editor = { ...viewer, role: "editor" };
  const binding = [{ organizationId: "o" } as PortalAccess];

  const writeTool = tool({ capability: "app.write", write: true });
  const readTool = tool({});
  const portalTool = tool({ portalSafe: true });

  assertEquals(toolAllowed(writeTool, viewer, []), false);
  assertEquals(toolAllowed(writeTool, editor, []), true);
  assertEquals(toolAllowed(readTool, viewer, []), true);
  assertEquals(toolAllowed(readTool, viewer, binding), false, "portal viewers need portalSafe");
  assertEquals(toolAllowed(portalTool, viewer, binding), true);
  assertEquals(
    toolAllowed(tool({ capability: "app.read" }), { ...viewer, role: "made-up" }, []),
    false,
  );
});

Deno.test("agent tool registry: write tools carry the confirmation metadata", () => {
  const w = toolDefinition(tool({ write: true }));
  assertEquals(w.annotations, { readOnlyHint: false, destructiveHint: true });
  assertEquals(w._meta, { "chipp/requiresConfirmation": true });
  const r = toolDefinition(tool({}));
  assertEquals(r.annotations, { readOnlyHint: true, destructiveHint: false });
  assertEquals(r._meta, undefined);
});

Deno.test("agent tool args: validation", () => {
  const schema = {
    type: "object" as const,
    properties: {
      id: { type: "string" as const, format: "uuid" as const },
      limit: { type: "integer" as const, minimum: 1, maximum: 10 },
      status: { type: "string" as const, enum: ["a", "b"] },
      name: { type: "string" as const, minLength: 1, maxLength: 3 },
      flag: { type: "boolean" as const },
    },
    required: ["id"],
  };
  const id = crypto.randomUUID();
  assertEquals(
    validateAgentToolArgs(schema, { id, limit: 3, status: "a", name: "ab", flag: true }).id,
    id,
  );
  assertEquals(validateAgentToolArgs({ type: "object", properties: {} }, undefined), {});

  const bad: unknown[] = [
    {},
    { id: "not-a-uuid" },
    { id, limit: 0 },
    { id, limit: 2.5 },
    { id, limit: "3" },
    { id, status: "c" },
    { id, name: "" },
    { id, name: "abcd" },
    { id, flag: "yes" },
    { id, organizationId: crypto.randomUUID() },
    [id],
    "id",
  ];
  for (const args of bad) {
    assertThrows(
      () => validateAgentToolArgs(schema, args),
      BadRequestError,
      undefined,
      JSON.stringify(args),
    );
  }
});
