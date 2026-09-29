/**
 * MCP OAuth discovery router stub (the `mcp-server` recipe).
 *
 * `app.ts` mounts this router at `/.well-known` for every recipe built from
 * this monorepo. Here it is empty, so the mount is inert.
 *
 * The `mcp-protocol-surface` pack (chipp-deno
 * src/alchemist/services/template-packs/) replaces this whole file in
 * `mcp-server` projects with the router that serves
 * `/.well-known/oauth-authorization-server` (RFC 8414) and
 * `/.well-known/oauth-protected-resource` (RFC 9728). Remote MCP clients
 * probe these at the origin root, so they cannot live under `/api/mcp`. Keep
 * the export name `mcpWellKnownRouter`, since `app.ts` imports it.
 */
import { Hono } from "hono";

export const mcpWellKnownRouter = new Hono();
