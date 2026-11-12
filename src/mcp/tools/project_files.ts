/**
 * Generic read tools: the project's documents and files (uploads, imports,
 * and generated files such as PDFs and exports). Every project has them.
 * Logic: src/services/mcp-data/documents.ts.
 *
 * capability app.read: every member, a viewer included, may use them. Not
 * portalSafe: a portal user is never shown the organization's files.
 */

import { z } from "zod";
import { registerMcpTool } from "@/mcp/registry.ts";
import { listDocuments, readDocument } from "@/services/mcp-data/documents.ts";
import {
  errorResult,
  readToolCaller,
  runRead,
  SIGN_IN_TEXT,
} from "@/mcp/tools/_read-tool-helpers.ts";

registerMcpTool({
  name: "list_documents",
  description: "List the documents and files in the caller's organization (uploads, imports, " +
    "generated PDFs and exports), newest first. Metadata only; use read_document for content.",
  inputSchema: {
    query: z.string().max(200).optional().describe("Only files whose name contains this text."),
    contentType: z.string().max(100).optional().describe(
      'Only files whose type starts with this, for example "application/pdf" or "image/".',
    ),
    subjectType: z.string().max(100).optional().describe(
      "Only files attached to this record type.",
    ),
    subjectId: z.string().max(200).optional().describe("Only files attached to this record id."),
    limit: z.number().int().min(1).max(200).optional().describe("Default 50."),
  },
  capability: "app.read",
  readOnly: true,
  handler: async (args, context) => {
    const caller = readToolCaller(context?.auth);
    if (!caller) return errorResult(SIGN_IN_TEXT);
    return await runRead("list_documents", async () => ({
      documents: await listDocuments({
        organizationId: caller.organizationId,
        viewer: { id: caller.userId, role: caller.role },
        query: args.query as string | undefined,
        contentType: args.contentType as string | undefined,
        subjectType: args.subjectType as string | undefined,
        subjectId: args.subjectId as string | undefined,
        limit: args.limit as number | undefined,
      }),
    }));
  },
});

registerMcpTool({
  name: "read_document",
  description: "Read one document by id. Text files come back as text. Every file comes with a " +
    "short-lived download URL; a small binary (for example a PDF) can come back as base64.",
  inputSchema: {
    id: z.string().uuid().describe("The document id from list_documents."),
    includeBase64: z.boolean().optional().describe(
      "For a binary file of 256 KB or less, also return its bytes as base64.",
    ),
  },
  capability: "app.read",
  readOnly: true,
  handler: async (args, context) => {
    const caller = readToolCaller(context?.auth);
    if (!caller) return errorResult(SIGN_IN_TEXT);
    return await runRead("read_document", () =>
      readDocument({
        id: args.id as string,
        organizationId: caller.organizationId,
        viewer: { id: caller.userId, role: caller.role },
        baseUrl: context?.baseUrl ?? null,
        includeBase64: args.includeBase64 === true,
      }));
  },
});
