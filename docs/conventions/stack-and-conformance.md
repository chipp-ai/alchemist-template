# The stack and the conformance check

## The stack is fixed

Chipp hosts apps built on this template, and its hosting is built around this
stack. Chipp runs your Postgres and Redis, scales the app on Kubernetes, reads
the logger's lines to find errors and fix them (self-healing), and reads the
Insights beacon for analytics. If you replace one of these parts, the app still
runs, but Chipp can no longer see it or fix it.

| Part | Use | Do not add |
|---|---|---|
| Server | Hono 4 (`app.ts`, `src/api/routes/`) | Express, Fastify, Koa, Oak, NestJS, Next.js, Nuxt, Remix, Elysia, Fresh, SvelteKit |
| UI | Svelte 5 + Vite in `web/`; Astro only in `landing/` | React, Vue, Angular, Solid, Preact, Qwik |
| Database | Postgres through Kysely (`src/db/client.ts`), SQL migrations in `db/migrations/` | Prisma, Drizzle, TypeORM, Sequelize, Mongoose, Knex, `pg`, MySQL, SQLite, Supabase, Firebase, Deno KV |
| Cache, locks, rate limits | Redis through `src/lib/redis.ts` | `ioredis`, npm `redis`, Upstash |
| Logs | `log` from `src/lib/logger.ts` | pino, winston, bunyan, log4js, consola, `@std/log` |
| Errors | `AppError` subclasses, `app.onError`, `log.error` | Sentry, Bugsnag, Rollbar, Honeybadger, Datadog, New Relic, LogRocket |
| Analytics | Chipp Insights (`src/lib/chipp-insights.ts`, `web/src/lib/chipp-insights.ts`) | PostHog, Mixpanel, Segment, Amplitude, Google Analytics or Tag Manager, Plausible, Hotjar |

Other libraries are fine. A PDF library, a date library or a chart library is
not a stack change.

## `deno task conformance`

Run it before every push:

```bash
deno task conformance          # human summary; exit 1 when an error blocks
deno task conformance --json   # the same report as JSON
```

It reads the repo only (no network, no type check) and takes well under a
second. The same file (`scripts/conformance.ts`) runs in the Chipp build, so
the local result is the publish result. Chipp runs its own copy: editing or
deleting this one does not change the build.

### Errors: publish is refused

| Rule | Meaning |
|---|---|
| `stack.web-framework` | another server or full-stack framework in `deno.json`, a `package.json` or an import |
| `stack.frontend-framework` | another UI framework (or Astro outside `landing/`) |
| `stack.db-client` | another ORM or database client, or `Deno.openKv` |
| `stack.logger` | another logger |
| `stack.error-reporting` | an error-reporting or APM SDK, or its browser script |
| `stack.analytics` | another analytics SDK, or its `<script>` host in a page |
| `stack.runtime` | `deno.json` missing or not valid JSON |
| `core.missing` | a core file is gone: `main.ts`, `app.ts`, `src/lib/logger.ts`, `src/lib/env.ts`, `src/db/client.ts`, `db/migrate.ts`, the three Insights modules, `src/api/routes/auth/index.ts` |
| `core.bypassed` | a core file exists but is cut out: `main.ts` does not import `./app.ts`; `app.ts` has no `new Hono`, no `app.onError` or no Insights middleware; the logger does not export `log`; `src/db/client.ts` does not build Kysely |

### Warnings: publish goes ahead and returns them

| Rule | Meaning |
|---|---|
| `drift.console` | `console.*` in server code under `src/` (console lines never reach Chipp's error detection) |
| `drift.direct-env` | `Deno.env.get` outside `src/lib/env.ts` |
| `drift.raw-db-client` | the raw `postgres` driver imported outside `src/db/` |
| `drift.dev-dependency` | a stack SDK listed only as a dev dependency |
| `drift.root-package-json` | a `package.json` at the repo root |
| `drift.base-file-missing` | `web/src/routes.ts`, the sidebar, `.alchemist/deployment.yaml`, `CLAUDE.md` or `AGENTS.md` is gone |
| `drift.conformance-task-missing` | `deno.json` has no `conformance` task |
| `drift.insights-inactive` | `chipp-insights.json` is missing (Chipp writes it when it creates the project) |

Each finding has a stable `key` (`<rule>:<subject>`), a `message`, and a `fix`
that says what to do. Fix the error; do not work around the rule.

### What Chipp does with the result

- Every build runs the check before the type check. A new error fails the
  build with `Template conformance failed:` and the same summary. Nothing
  goes live.
- An app that was already live with a finding before the check existed keeps
  that finding as `grandfathered`. It does not block, but a NEW swap does.
- Warnings are saved with the deploy and returned in the publish result.

## Why the logger matters most

Chipp's self-healing reads the production NDJSON lines from
`src/lib/logger.ts` and the errors `app.onError` logs. Then it files a fix
ticket for each new error. Use `log.error(msg, ctx, err)` with the `Error` as the
third argument, so the stack trace is kept. See `observability.md` and `api.md`.
