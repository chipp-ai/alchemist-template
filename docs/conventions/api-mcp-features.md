# Built-in API and MCP features

## Built-in API and MCP features: OFF until the project turns them on

Every project ships two optional features. Both are complete and tested,
and both are switched OFF by default: while off, every route they own
answers 404, so nothing is exposed. **When a ticket asks for "an API",
"API keys", "paid API routes", "an MCP server", "connect this to Claude or
ChatGPT", turn the feature on and build on it. Never write a second API-key
system, OAuth server or MCP endpoint.**

| Feature | Switch (env) | What turns on | Guide |
|---|---|---|---|
| API | `ALCHEMIST_FEATURE_API=1` | `/api/api-keys` (api_sk_ keys) and `/api/v1/*` (add routes in `src/services/headless-api/v1.ts`), paid via `chargeCredits` / `requirePurchase` / `mppPaid` | `docs/agent-guidance/headless-api-surface.md` |
| MCP | `ALCHEMIST_FEATURE_MCP=1` | `/api/mcp`, OAuth 2.1 + PKCE + dynamic client registration under `/api/mcp/oauth`, `/.well-known/oauth-*`, `/api/mcp/api-keys` (mcp_sk_ keys); tools in `src/mcp/tools/` | `docs/agent-guidance/mcp-protocol-surface.md` |

- **Turning one on:** on the Alchemist platform, the builder or the agent
  calls the `set_project_feature` tool (`feature: "api"` or `"mcp"`,
  `enabled: true`); the platform sets the env var and redeploys. Locally,
  put the var in `.env` and restart. Both can be on at once.
- **The gate:** `src/lib/features.ts` (`featureEnabled`, `requireFeature`).
  A gate sits on the exact paths a feature owns, never on a prefix other
  routes share (the API router is mounted at `/api`).
- **Tests** flip a feature with `setFeatureForTests(...)`, never
  `Deno.env.set` (parallel test workers share `Deno.env`).
- The credit ledger (`src/services/credit.service.ts`) and the OAuth tables
  exist in every project either way. Both features spend the same
  organization credit balance.
