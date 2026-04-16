# Alchemist Template

A production-ready SaaS starter template built with Deno, Hono, Svelte 5, and PostgreSQL. Designed for autonomous AI-driven development via the Alchemist AI platform.

## Quick Start

```bash
# First-time setup (checks tools, installs deps, starts Docker, runs migrations)
./scripts/setup.sh

# Start the dev stack
./scripts/dev.sh --api-port 8000 --port 5173

# Open the app
open http://localhost:5173
```

## Architecture

| Layer | Tech | Directory |
|-------|------|-----------|
| API Server | Deno + Hono | `src/api/routes/`, `src/services/` |
| Frontend | Svelte 5 SPA | `web/src/` |
| Database | PostgreSQL + Kysely | `db/migrations/`, `src/db/` |
| Cache | Redis | via `redis` Deno module |
| Auth | Sessions + JWT + OAuth | `src/api/middleware/` |
| Billing | Stripe | `src/services/billing/` |

**Key patterns:**
- Routes are thin orchestration -- business logic lives in services
- Kysely with CamelCasePlugin (camelCase in TS, snake_case in SQL)
- SQL migrations in `db/migrations/` (auto-applied on startup)
- Structured logging (pretty in dev, NDJSON in production)
- Type-safe request validation via Zod + Hono validators

## Customizing for Your Product

1. **Update `CLAUDE.md`** -- Replace the header description with your product description. This is what the AI reads to understand the project.
2. **Update `web/index.html`** -- Change the `<title>` tag.
3. **Add your schema** -- Create new migration files in `db/migrations/` following the `NNN_description.sql` naming convention. Update `src/db/schema.ts` with matching TypeScript types.
4. **Add routes** -- Create route files in `src/api/routes/` and mount them in the main router.
5. **Add services** -- Create service files in `src/services/` for your business logic.
6. **Add pages** -- Create Svelte components in `web/src/routes/` and register them in the router.

## Development

```bash
# Type check
deno task check

# Run tests (fast -- routes + services only)
deno task test:fast

# Run all tests
deno task test

# Format code
deno fmt

# Lint
deno lint

# Run a specific test file
deno test --env --no-check --allow-all src/__tests__/services/my_test.ts
```

## Deployment

Deploy via Alchemist AI (autonomous CI/CD) or self-host on any Kubernetes cluster.

The project includes:
- Docker-compatible Deno runtime
- PostgreSQL migrations (auto-applied before deploy)
- Health check endpoint at `/health`
- Structured NDJSON logging for production log aggregation
- Cloudflare Worker support for edge proxy (optional)

## License

Private. All rights reserved.
