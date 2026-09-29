/**
 * MCP protocol router stub (the `mcp-server` recipe).
 *
 * `app.ts` mounts this router at `/api/mcp` (and `/api/mcp/`) for every recipe
 * built from this monorepo. Here it is empty, so the mount is inert.
 *
 * The `mcp-protocol-surface` pack (chipp-deno
 * src/alchemist/services/template-packs/) replaces this whole file in
 * `mcp-server` projects with the router that serves the MCP endpoint and the
 * OAuth authorization server under `/api/mcp`. The pack overlay writes the
 * complete file: it never appends to this one. Keep the export name
 * `mcpProtocolRouter`, since `app.ts` imports it.
 *
 * OAuth discovery (`/.well-known/*`) is a separate stub
 * (`well-known-router.ts` in this directory): RFC 8414 and RFC 9728 require
 * those documents at the origin root, not under `/api/mcp`.
 */
import { Hono } from "hono";

export const mcpProtocolRouter = new Hono();
