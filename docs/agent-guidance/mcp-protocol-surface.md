# MCP feature (MCP server)

Built into every project and OFF by default. Turn it on when the project
should be usable from Claude, ChatGPT or any MCP client: an MCP server at
/api/mcp with OAuth 2.1 and paid tools that read the project's own data.

## Turning it on

- On the Alchemist platform: the builder, or the builder's agent, calls the
  `set_project_feature` tool with `feature: "mcp"`, `enabled: true`. The
  platform sets `ALCHEMIST_FEATURE_MCP=1` in the project env and redeploys.
- Local dev and tests: `ALCHEMIST_FEATURE_MCP=1` in `.env`, then restart.
  In a test, call `setFeatureForTests("mcp", true)` (src/lib/features.ts).

While it is off, /api/mcp, its OAuth endpoints, /api/mcp/api-keys and the
/.well-known/oauth-* documents all answer 404. The OAuth and credit tables
exist in every project either way. The API feature can be on at the same
time.

## Where things are

- src/services/mcp-protocol/router.ts: mounted at /api/mcp by app.ts.
  src/services/mcp-protocol/well-known-router.ts: OAuth discovery at the
  origin root (/.well-known), as RFC 8414 and RFC 9728 require. Never edit
  app.ts.
- src/mcp/registry.ts: registerMcpTool({ name, description, inputSchema,
  handler, price?, requiredProductKey?, creditCost? }). Names are unique.
- src/mcp/tools/*.ts: one tool per file, registered by a side-effect import
  in src/mcp/server.ts. team_summary.ts is the pattern for a tool that reads
  the caller's own data; echo.ts is a harmless example.
- src/mcp/gates.ts: requiredProductKey (entitlement, returns a checkout
  link) and creditCost (prepaid debit, refunded if the tool fails). price
  (MPP machine payments, src/mcp/mpp.ts) is the third option and cannot be
  combined with creditCost.
- src/api/middleware/mcp-auth.ts: MCP_AUTH_MODE=public (default, anonymous
  calls allowed, identity-gated tools ask the client to connect) or oauth
  (Bearer mcp_at_... or mcp_sk_... required). Switch to oauth as soon as a
  tool exposes anything non-public.
- src/api/routes/mcp/oauth.ts and src/services/mcp-oauth/: the OAuth 2.1
  authorization server, with PKCE and RFC 7591 dynamic client registration
  (POST /api/mcp/oauth/register).
- src/api/routes/mcp/api-keys.ts: GET/POST/DELETE /api/mcp/api-keys, mcp_sk_
  keys for headless callers (session only, shown once).

## Rules

- Add a tool through registerMcpTool in a new file under src/mcp/tools/ and
  import it in server.ts. Never hand-roll an HTTP endpoint for a tool.
- Clients register themselves (DCR). Never hard-code client ids or secrets.
- Charge per tool (creditCost or price), not per request.
- A tool that reads data scopes every query to
  context.auth.organizationId. Never trust an org or tenant id passed as a
  tool argument (CWE-639). With no auth context, return a "connect with
  OAuth" message.
- Tests: src/__tests__/routes/mcp-feature.test.ts and
  src/__tests__/routes/builtin-features.test.ts.
