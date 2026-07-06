<div align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/logo-dark.svg">
    <img src="docs/logo-light.svg" alt="Alchemist Template" width="520">
  </picture>
  <p><strong>A production-grade SaaS template, built so AI agents can extend it without breaking it.</strong></p>
  <p>
    <a href="#quick-start">Quick Start</a> &#8226;
    <a href="#whats-in-the-box">What's in the Box</a> &#8226;
    <a href="#architecture">Architecture</a> &#8226;
    <a href="#customizing-for-your-product">Customizing</a> &#8226;
    <a href="#working-with-ai-agents">Agents</a> &#8226;
    <a href="#license">License</a>
  </p>
</div>

---

Alchemist Template is a SaaS starter built on Deno 2, Hono 4, Svelte 5, and PostgreSQL. It ships with auth, billing, RBAC, structured logging, and an idiomatic Kysely + services layout, plus a `CLAUDE.md` authored so AI agents (Claude Code, Cursor, or the [Alchemist AI](https://adaas.dev) platform itself) can navigate and extend it without fighting the conventions. Fork it as the starting point for any new product.

It is also the seed repo every customer project on the [Alchemist AI](https://adaas.dev) platform is cloned from. The conventions here are the ones autonomous agents are trained against -- using this template means agents work with you, not around you.

## What's in the box

- **API** -- Deno 2 + Hono 4 with Zod request validation and typed error handling.
- **SPA** -- Svelte 5 (runes) + Vite, hash-based router, typed fetch wrapper.
- **Database** -- PostgreSQL via Kysely with `CamelCasePlugin` (camelCase in TS, snake_case in SQL). Migrations are plain SQL files in `db/migrations/`, auto-applied on startup.
- **Cache + sessions** -- Redis, with helpers for rate limits and key-scoped invalidation.
- **Auth** -- Email OTP login, session cookies, JWT for API tokens, OAuth providers via Arctic 2. Includes a documented dev-login escape hatch so local + agent testing works without an SMTP inbox.
- **Billing** -- Stripe 17. Plan-tier subscriptions, customer portal, AND a built-in product catalog: sell one-time purchases or monthly/yearly subscriptions with automatic Stripe product/price creation, webhook fulfillment, and org-level entitlements (`requireEntitlement`).
- **Email** -- SMTP via nodemailer with environment-driven configuration.
- **RBAC + teams** -- Organizations, members, roles, invites. Wired through the auth middleware and routes.
- **Logging** -- Structured logger (pretty in dev, NDJSON in production), ready for Loki / Datadog / any aggregator.
- **Tests** -- Routes + services split (`test:fast` runs just those). No DB mocks -- tests hit a real Postgres instance.
- **Container-ready** -- Dockerfile + docker-compose for the dev stack; k8s-compatible image for any cluster.
- **`CLAUDE.md`** -- Authored for AI agents. They read it on session 1 and immediately know your conventions, dev login, gotchas.

## Architecture

```
Browser
   |
   v
Svelte 5 SPA              (web/)
   |   hash-based routing, runes stores, typed fetch
   v
Hono 4 API                (src/api/routes/  ->  src/services/)
   |   Zod-validated, session + JWT auth, structured errors
   v
PostgreSQL                (Kysely, NNN_*.sql migrations auto-applied)
   +
Redis                     (sessions, cache, rate limits)
   +
Stripe                    (subscriptions, credits, customer portal)
```

**Stack:** Deno 2, Hono 4, Svelte 5 (runes), Vite, Kysely 0.27, PostgreSQL, Redis, Arctic 2, Stripe 17, Zod 3, nodemailer 6.

## Quick start

### 1. Clone and bootstrap

```bash
git clone https://github.com/chipp-ai/alchemist-template.git my-app
cd my-app
./scripts/setup.sh
```

`setup.sh` checks your toolchain (Deno, Docker), installs the SPA dependencies, brings up Postgres + Redis via `docker-compose`, and runs all migrations.

### 2. Start the dev stack

```bash
./scripts/dev.sh --api-port 8000 --port 5173
```

This runs the Hono API on `:8000` and the Vite SPA on `:5173` in one terminal. Open `http://localhost:5173`.

> **Always use the Vite URL (`:5173`) in your browser**, not the API URL. Vite serves the SPA shell and proxies `/api/*` to the API. Hitting `:8000` directly will 404 everything that isn't an API route.

### 3. Log in (no SMTP needed)

There's no SMTP harness in dev, so OTP codes never reach an inbox. Use the dev-login escape hatch instead:

- **In the browser:** the Login page renders a "Dev login as ..." button below the OTP form (only visible when `import.meta.env.DEV`). It POSTs to `/api/dev/login` and sets a real session.
- **From an agent or terminal:**
  ```bash
  curl -X POST -H 'Content-Type: application/json' \
       -d '{"email":"agent@dev.local"}' \
       http://localhost:8000/api/dev/login \
       -c /tmp/jar.txt
  ```
  Re-use the cookie jar with `-b /tmp/jar.txt` on subsequent requests.

The `/api/dev/*` routes 404 when `NODE_ENV=production`, and the dev-login button is stripped from production SPA builds -- both surfaces are local-only by construction.

## Project structure

```
src/
  api/
    routes/        Hono handlers (thin orchestration)
    middleware/    auth, validation, error handling
  services/        business logic (one file per domain)
  db/
    client.ts      Kysely client (CamelCasePlugin)
    schema.ts      table type definitions
  lib/logger.ts    structured logger (NDJSON in prod)
  __tests__/
    routes/        route integration tests
    services/      service unit tests
    helpers.ts     test utilities (createIsolatedUser, ...)
web/
  src/
    routes/        Svelte 5 pages (hash router)
    stores/        runes-based state
    lib/api.ts     typed fetch wrapper with 401 handling
db/
  migrations/      NNN_*.sql files, auto-applied on startup
  migrate.ts       migration runner
scripts/
  setup.sh         one-shot dev bootstrap
  dev.sh           run API + Vite together
CLAUDE.md          project context for AI agents
```

## Customizing for your product

This template is intentionally generic. The path from clone to "your product" is:

1. **Rewrite `CLAUDE.md`.** Replace the `[Project Name]` header and `[Brief description...]` paragraph with what you're actually building. This is the file every AI agent reads first -- get it right and agents need almost no orientation. See [working with AI agents](#working-with-ai-agents) below.
2. **Update `web/index.html`.** Change the `<title>` and any meta tags.
3. **Centralize brand in `src/config/brand.ts`.** App name, logo, colors, marketing copy -- the template reads from one place so there are no string-literal leaks of "Alchemist" anywhere in your fork.
4. **Add your schema.** Create migration files in `db/migrations/` following the `NNN_description.sql` convention. The runner applies them in order on startup. Update `src/db/schema.ts` with matching TypeScript types -- the `CamelCasePlugin` handles the case conversion at the DB boundary.
5. **Add routes + services.** Drop new files into `src/api/routes/` and mount them in `src/api/index.ts`. Put the logic in `src/services/`. Keep routes thin.
6. **Add pages.** Create components in `web/src/routes/` and register them with the hash router.

The template ships with the foundation you'd otherwise build yourself: organizations, users, sessions, OAuth, OTP, Stripe customers + subscriptions, credit grants, user preferences, team invites. You shouldn't have to touch most of it -- just build your domain on top.

## Working with AI agents

This template was authored so AI agents (Claude Code, Cursor, the [Alchemist AI](https://adaas.dev) platform) can extend it without ramp-up. Two things make that work:

**`CLAUDE.md` at the root** documents the stack, layout, conventions, dev login flow, and gotchas. Claude Code auto-loads it on every session; other agents you point at the repo can be told to read it first. When you fork, update it:

- Replace the project header with your product name + a real description of what it does.
- Document anything domain-specific (e.g. "events always carry a UTC timestamp", "we never delete records -- soft-delete via `archived_at`").
- Add your testing conventions, deployment specifics, and any patterns that look wrong but are intentional.

**Predictable layout.** Routes are thin orchestration; business logic lives in services; DB types come from `src/db/schema.ts`. Agents that know the pattern can add a new feature without searching for the right file. The Alchemist AI platform's agents are trained against exactly this shape.

If you also want autonomous error remediation, mission orchestration, and a kanban for agent work on top of this template, see [chipp-ai/dispatch](https://github.com/chipp-ai/dispatch).

## Development

```bash
deno task dev          # Run API with --watch
deno task check        # Type-check
deno task test:fast    # Route + service tests
deno task test         # Full test suite
deno task fmt          # Format
deno task lint         # Lint
deno task db:migrate   # Apply pending migrations explicitly
```

Run a single test file:

```bash
deno test --env --no-check --allow-all src/__tests__/services/my_test.ts
```

## Deployment

### Alchemist AI (autonomous)

Push to your fork's default branch. The Alchemist AI platform builds, migrates, and rolls out via its build orchestrator and rollout controller. No CI to configure -- the platform's own agents handle deploys.

### Self-host on Kubernetes

The Dockerfile produces a runtime-image suitable for any cluster. You need:

- A PostgreSQL instance (the app auto-applies migrations on boot).
- A Redis instance.
- Environment variables from `.env.example` (database URL, Redis URL, session secret, Stripe keys, OAuth credentials, SMTP config).

Mount the secrets, point at your databases, and run the image. A `/health` endpoint is exposed for liveness probes.

### Docker Compose

```bash
docker-compose up
```

For local end-to-end runs without the Vite dev server.

## Contributing

Issues and pull requests welcome. If you're using Claude Code or another AI agent to contribute, the [`CLAUDE.md`](CLAUDE.md) in the repo root has the project context they'll need.

## License

[MIT](LICENSE)
