/**
 * Example PAID tool -- demonstrates a monetized tool that reads the
 * CALLING ORG'S OWN project data, not a canned example.
 *
 * Every real MCP server should expose the project's own data through
 * tools like this one, not a generic echo. This one is scoped to the
 * caller's own organization (never cross-org -- CWE-639) and costs 1
 * credit per call via the prepaid credit gate in src/mcp/gates.ts.
 *
 * Replace or delete this example in real projects; keep the pattern:
 * read `auth.organizationId` from the resolved MCP auth context, scope
 * every query to it, and never trust a caller-supplied org/tenant id.
 */

import { z } from "zod";
import { registerMcpTool } from "@/mcp/registry.ts";
import { db } from "@/db/client.ts";

registerMcpTool({
  name: "get_team_summary",
  description:
    "Returns a summary of the caller's own organization: team size, role breakdown, and the most recent signup.",
  inputSchema: {},
  creditCost: 1,
  handler: async (_args, context) => {
    const organizationId = context?.auth?.organizationId ?? null;
    if (!organizationId) {
      return {
        content: [{
          type: "text",
          text: "This tool requires a signed-in account. Connect this MCP server with OAuth first.",
        }],
      };
    }

    const rows = await db
      .selectFrom("users")
      .select(["role", "createdAt"])
      .where("organizationId", "=", organizationId)
      .execute();

    const roleCounts: Record<string, number> = {};
    let mostRecent: string | null = null;
    for (const row of rows) {
      roleCounts[row.role] = (roleCounts[row.role] ?? 0) + 1;
      const createdAt = row.createdAt instanceof Date ? row.createdAt.toISOString() : String(row.createdAt);
      if (!mostRecent || createdAt > mostRecent) mostRecent = createdAt;
    }

    const summary = {
      teamSize: rows.length,
      roleCounts,
      mostRecentSignupAt: mostRecent,
    };

    return {
      content: [{ type: "text", text: JSON.stringify(summary, null, 2) }],
    };
  },
});
