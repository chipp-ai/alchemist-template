/**
 * MCP HTTP Route
 *
 * Serves a Model Context Protocol server over Streamable HTTP at /api/mcp.
 *
 * The transport is stateless (sessionIdGenerator: undefined) — a fresh
 * transport is created per request. This is the simplest model for a
 * starter and avoids sticky session concerns.
 *
 * Security — Origin validation (DNS rebinding / cross-site protection):
 *   The MCP spec REQUIRES HTTP servers to validate the Origin header to
 *   prevent DNS-rebinding attacks, where a malicious web page the victim
 *   visits POSTs to the (often unauthenticated, sometimes localhost) MCP
 *   endpoint from the victim's browser and invokes tools. The app's global
 *   CORS reflects any origin with credentials, so without this guard any
 *   web page could reach this endpoint cross-site.
 *
 *   Legitimate MCP clients (Claude Desktop, IDE/CLI plugins, the Inspector
 *   proxy) are Node-based and send NO Origin header, so this guard does not
 *   affect them: requests with no Origin pass through. Only browser-issued
 *   cross-site requests (which always carry an Origin) are rejected unless
 *   the origin is explicitly allowlisted via MCP_ALLOWED_ORIGINS
 *   (comma-separated). Default allowlist is empty → all browser origins are
 *   rejected, which is the correct posture for a headless server.
 *
 * Wire-up (in app.ts):
 *   import { mcpRoutes } from "@/api/routes/mcp/index.ts";
 *   app.route("/api/mcp", mcpRoutes);
 */

import { Hono } from "hono";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { createMcpServer } from "@/mcp/server.ts";
import { getMcpAuth, mcpAuthMiddleware } from "@/api/middleware/mcp-auth.ts";
import { requestBaseUrl } from "@/api/routes/well-known.ts";

const mcpRoutes = new Hono();

/**
 * Parse the MCP_ALLOWED_ORIGINS env var into a normalized allowlist.
 * Read per-request (negligible cost) so deploys/tests that set the env
 * see it without a process restart.
 */
function allowedOrigins(): Set<string> {
  const raw = Deno.env.get("MCP_ALLOWED_ORIGINS") ?? "";
  return new Set(
    raw
      .split(",")
      .map((o) => o.trim().toLowerCase())
      .filter((o) => o.length > 0),
  );
}

/**
 * Returns true if the request is allowed to reach the MCP server.
 * - No Origin header → allowed (non-browser MCP client, the normal case).
 * - Origin present → allowed only if it is in the configured allowlist.
 */
function isOriginAllowed(req: Request): boolean {
  const origin = req.headers.get("origin");
  // No Origin header AT ALL → non-browser MCP client (Claude Desktop, IDE/CLI
  // plugins, Inspector proxy). An EMPTY Origin value ("Origin:") is NOT the
  // same as an absent header — it is still a present Origin, so it must be
  // treated as a (disallowed-by-default) browser origin rather than waved
  // through. `headers.get` returns null only when the header is truly absent.
  if (origin === null) return true;
  return allowedOrigins().has(origin.toLowerCase());
}

// Origin guard runs BEFORE auth so cross-site browser requests are rejected
// without any DB work. JSON-RPC-shaped error so MCP clients get a sensible
// body.
mcpRoutes.use("/", async (c, next) => {
  if (!isOriginAllowed(c.req.raw)) {
    return c.json(
      {
        jsonrpc: "2.0",
        error: { code: -32000, message: "Origin not allowed" },
        id: null,
      },
      403,
    );
  }
  await next();
});

mcpRoutes.all("/", mcpAuthMiddleware, async (c) => {
  // Fresh server + transport per request (stateless mode). The resolved
  // caller identity + request base URL feed the monetization gates.
  const server = createMcpServer({
    auth: getMcpAuth(c),
    baseUrl: requestBaseUrl(c),
  });
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
  });

  await server.connect(transport);

  // The SDK's WebStandard transport expects a raw Request and returns a Response
  const response = await transport.handleRequest(c.req.raw);
  return response;
});

export { mcpRoutes };
