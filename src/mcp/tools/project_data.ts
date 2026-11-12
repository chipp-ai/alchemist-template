/**
 * Generic read tools: the app's data model and read-only rows from its own
 * tables. Every project has them. Logic and the full safety model:
 * src/services/mcp-data/data-access.ts (hidden auth and secret tables and
 * columns, organization pin, structured query only, READ ONLY transaction,
 * statement timeout, row cap).
 *
 * capability app.read: every member, a viewer included. Some tables need a
 * higher capability, checked per table. Not portalSafe.
 */

import { z } from "zod";
import { registerMcpTool } from "@/mcp/registry.ts";
import {
  describeDataModel,
  FILTER_OPS,
  MAX_QUERY_ROWS,
  queryTable,
} from "@/services/mcp-data/data-access.ts";
import {
  errorResult,
  readToolCaller,
  runRead,
  SIGN_IN_TEXT,
} from "@/mcp/tools/_read-tool-helpers.ts";

registerMcpTool({
  name: "describe_data_model",
  description: "Describe this app's data model: tables, columns, types, primary keys and " +
    "relations. Sign-in, secret and system tables are left out. Use it before query_data.",
  inputSchema: {
    table: z.string().max(100).optional().describe("Only this table."),
  },
  capability: "app.read",
  readOnly: true,
  handler: async (args, context) => {
    const caller = readToolCaller(context?.auth);
    if (!caller) return errorResult(SIGN_IN_TEXT);
    return await runRead("describe_data_model", async () => {
      const tables = await describeDataModel(caller.role);
      const only = args.table as string | undefined;
      return {
        tables: only ? tables.filter((t) => t.table === only) : tables,
        notes: "Only tables with an organization_id column are queryable. Rows are always " +
          "limited to your organization.",
      };
    });
  },
});

const filterSchema = z.object({
  column: z.string().max(100),
  op: z.enum(FILTER_OPS),
  value: z.union([
    z.string().max(1000),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(z.union([z.string().max(1000), z.number(), z.boolean()])).max(100),
  ]).optional().describe('Not used by "is_null" and "not_null". An array for "in".'),
});

registerMcpTool({
  name: "query_data",
  description: "Read rows from one of this app's tables (read only, your organization only). " +
    "Pick columns, add simple filters, order and limit. Call describe_data_model first for " +
    `table and column names. At most ${MAX_QUERY_ROWS} rows per call; page with offset.`,
  inputSchema: {
    table: z.string().max(100).describe("Table name from describe_data_model."),
    columns: z.array(z.string().max(100)).max(100).optional().describe(
      "Default: every visible column.",
    ),
    filters: z.array(filterSchema).max(20).optional().describe("All filters must match (AND)."),
    orderBy: z.object({
      column: z.string().max(100),
      direction: z.enum(["asc", "desc"]).optional(),
    }).optional(),
    limit: z.number().int().min(1).max(MAX_QUERY_ROWS).optional().describe("Default 50."),
    offset: z.number().int().min(0).max(100_000).optional(),
  },
  capability: "app.read",
  readOnly: true,
  handler: async (args, context) => {
    const caller = readToolCaller(context?.auth);
    if (!caller) return errorResult(SIGN_IN_TEXT);
    return await runRead("query_data", () =>
      queryTable(
        {
          table: args.table as string,
          columns: args.columns as string[] | undefined,
          filters: args.filters as Parameters<typeof queryTable>[0]["filters"],
          orderBy: args.orderBy as Parameters<typeof queryTable>[0]["orderBy"],
          limit: args.limit as number | undefined,
          offset: args.offset as number | undefined,
        },
        { organizationId: caller.organizationId, role: caller.role },
      ));
  },
});
