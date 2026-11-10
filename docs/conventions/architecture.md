# Architecture

## Architecture

```
src/                    # Deno + Hono API server
  api/
    routes/             # Hono route handlers (thin orchestration)
    middleware/          # Auth, validation, error handling
  services/             # Business logic (one service per domain)
    email-outbox.service.ts   # enqueueEmail() — durable, retried, idempotent sends
    scheduled-jobs.service.ts # cron schedules (create/update/run)
  jobs/
    runner.ts           # in-process tick loop (every replica, SKIP LOCKED claims)
    registry.ts         # defineJob(kind, handler)
    handlers/           # one file per job kind; import each from jobs/index.ts
  db/
    client.ts           # Kysely client with CamelCasePlugin
    schema.ts           # TypeScript type definitions for all tables
  lib/
    logger.ts           # Structured logger (dev: pretty, prod: NDJSON)
  utils/                # Shared utilities (errors, validation hooks)
  __tests__/
    routes/             # Route integration tests
    services/           # Service unit tests
    helpers.ts          # Test utilities (createIsolatedUser, etc.)

web/                    # Svelte 5 SPA, served at /app (hash routes: /app/#/settings)
  src/
    design/             # design.json (THE look), presets, fonts catalog, tokens, apply
    routes/             # Page components (hash-based routing); Design.svelte = the sheet
    stores/             # Svelte stores (state management)
    lib/
      api.ts            # Typed fetch wrapper with 401 handling

landing/                # Astro static landing site, served at "/" (marketing pages)
  src/content/site.json # ALL landing copy: name, definition, main question, FAQ, dates
  src/content/pages/    # composed pages: one JSON per page, any path, built from sections
  src/content/posts/    # blog posts: one JSON per post, at its own path
  src/pages/            # index.astro ("/"), [...path].astro (every other page), sitemap.xml, robots.txt
  scripts/aeo-check.mjs # runs after astro build; fails the build on an AEO rule

db/
  migrations/           # SQL migration files (YYYYMMDDHHMMSS_description.sql)
  migrate.ts            # Migration runner

scripts/
  dev.sh                # Start full dev stack
  setup.sh              # First-time project setup

.scratch/               # Ephemeral files (gitignored except .gitkeep)
  logs/                 # Dev server logs (server.log, vite.log)
```

**Stack:**
- **API:** Deno + Hono
- **Frontend:** Svelte 5 SPA with hash-based routing (`svelte-spa-router`), served at `/app`
- **Landing site:** static Astro site in `landing/`, served at `/` (see "Landing site" below)
- **Database:** PostgreSQL via Kysely (CamelCasePlugin)
- **Cache / locks / rate limits:** shared platform Redis via `src/lib/redis.ts` (best-effort, fail-open -- see "Shared Redis" below). Sessions are stateless JWT cookies, NOT server-side session storage.
- **Edge Proxy:** Cloudflare Worker (when deployed)
