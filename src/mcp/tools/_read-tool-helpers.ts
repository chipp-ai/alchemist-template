/**
 * Shared helpers for the generic read tools (project_files.ts,
 * project_data.ts): the signed-in caller from the MCP auth context, and
 * tool results for success and for a refusal.
 */

import type { McpAuthContext } from "@/api/middleware/mcp-auth.ts";
import { AppError } from "@/utils/errors.ts";
import { log } from "@/lib/logger.ts";

export interface ReadToolCaller {
  userId: string;
  organizationId: string;
  role: string;
}

type TextResult = { content: Array<{ type: "text"; text: string }>; isError?: boolean };

export const SIGN_IN_TEXT =
  "This tool needs a signed-in account. Connect this MCP server with OAuth first.";

/**
 * The caller, or null. The server already checked the capability against
 * the person's CURRENT role and org (mcpToolAccess); the auth context's
 * role and org are read from the users row on every request.
 */
export function readToolCaller(auth: McpAuthContext | null | undefined): ReadToolCaller | null {
  if (!auth || !auth.organizationId) return null;
  return { userId: auth.userId, organizationId: auth.organizationId, role: auth.role };
}

export function jsonResult(value: unknown): TextResult {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
}

export function errorResult(text: string): TextResult {
  return { isError: true, content: [{ type: "text", text }] };
}

/** Run a read; an AppError becomes a plain tool error, anything else is logged. */
export async function runRead(toolName: string, fn: () => Promise<unknown>): Promise<TextResult> {
  try {
    return jsonResult(await fn());
  } catch (err) {
    if (err instanceof AppError) return errorResult(err.message);
    log.error(
      "MCP read tool failed",
      { source: "mcp", feature: "read-tools", toolName },
      err as Error,
    );
    return errorResult("The read failed. Try again, or narrow the request.");
  }
}
