# API feature (headless API product)

Built into every project and OFF by default. Turn it on when the project
sells or exposes an API: callers authenticate with a browser session or an
API key, and routes can be paid.

## Turning it on

- On the Alchemist platform: the builder, or the builder's agent, calls the
  `set_project_feature` tool with `feature: "api"`, `enabled: true`. The
  platform sets `ALCHEMIST_FEATURE_API=1` in the project env and redeploys.
- Local dev and tests: `ALCHEMIST_FEATURE_API=1` in `.env`, then restart.
  In a test, call `setFeatureForTests("api", true)` (src/lib/features.ts)
  instead of touching `Deno.env`.

While it is off, every route below answers 404. The credit tables exist in
every project either way.

## Where things are

- src/services/headless-api/router.ts: mounted at /api by app.ts. It owns
  exactly /api/api-keys and /api/v1/*. Never edit app.ts for API routes.
- src/services/headless-api/v1.ts: the API product. Add routes here.
  GET /api/v1/team-summary is the example (1 credit, the caller's own
  organization only).
- src/api/middleware/api-key-auth.ts: requireAuthOrApiKey accepts the
  session cookie OR `Authorization: Bearer api_sk_...` and sets the same
  user context as requireAuth, so getUser(c) works for both.
- src/api/routes/api-keys/index.ts: GET/POST/DELETE /api/api-keys. Session
  only on purpose: a leaked key must not mint new keys. The plaintext key is
  shown once.
- src/api/middleware/monetize.ts, three gates:
  - requirePurchase(productKey): the caller's organization must own the
    product (src/services/product.service.ts). An unentitled call gets a
    checkout link.
  - chargeCredits(cost): debits the organization's prepaid credit balance
    (src/services/credit.service.ts, tables in src/db/credit-tables.ts).
    Not enough credit returns 402 with a top-up checkout link.
  - mppPaid(price): per-request machine payment (src/services/mpp.service.ts).
    Needs no identity: the payment is the credential.

## Rules

- Externally callable routes use requireAuthOrApiKey, then a gate.
  requirePurchase and chargeCredits need identity, so they come after it.
- Declare the price at the route (chargeCredits(5), mppPaid({ fiatUsd })),
  never inside the handler body.
- Scope every query to getUser(c).organizationId (see
  docs/agent-guidance/tenant-scope.md). A key proves who the caller is, not
  which rows they may read.
- The MCP feature has its own keys (mcp_sk_, /api/mcp/api-keys) in the same
  api_credentials table. Each surface lists, revokes and accepts only its
  own prefix; keep it that way.
- Tests: src/__tests__/routes/api-feature.test.ts and
  src/__tests__/routes/builtin-features.test.ts.
