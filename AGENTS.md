# AGENTS.md

This is the Chipp app template: an open-source (MIT) full-stack app on Deno 2,
Hono 4, Svelte 5, Postgres (Kysely) and Redis. Chipp (chipp.ai) hosts apps built
on it. This file is the guide for any coding agent working in this repo:
Claude Code, Codex, Cursor, Hermes or another one.

`CLAUDE.md` is the index: hard rules, commands, and one line per topic file in
`docs/conventions/`. Read it first. Then read the topic file for each area you
touch. Do not read every topic file.

## 1. The stack is fixed

Chipp's hosting is built around this stack: Postgres, Redis, Kubernetes
scaling, and the logger whose lines feed Chipp's error detection and
self-healing. Build on it. Never replace it.

- Server: Hono (`app.ts`, routes in `src/api/routes/`, logic in `src/services/`).
- UI: Svelte 5 in `web/`. The public site is Astro in `landing/`.
- Data: Postgres through Kysely (`src/db/client.ts`); schema changes are SQL
  files in `db/migrations/`. Cache, locks and rate limits use `src/lib/redis.ts`.
- Do not add another web or UI framework, ORM or database client, logger,
  error tracker or analytics SDK. Other libraries (PDF, dates, charts) are fine.
- Run `deno task conformance` before every push. An error blocks publish on
  Chipp. Rules and fixes: `docs/conventions/stack-and-conformance.md`.

## 2. Run it locally

You need Deno and Docker.

```bash
./scripts/setup.sh                                  # once: Postgres + Redis in Docker, web deps, migrations
./scripts/dev.sh --api-port 8000 --port 5173        # API + Vite
```

Open the Vite URL (`http://localhost:5173`), not the API port. Sign in with
the "Dev login" button, or
`curl -X POST -H 'Content-Type: application/json' -d '{"email":"agent@dev.local"}' http://localhost:8000/api/dev/login -c .scratch/jar.txt`.
Ports, HMR and the dev routes: `CLAUDE.md` "Quick Start" and
`docs/conventions/dev-affordances.md`. Tests and type checks:
`docs/conventions/testing.md`.

## 3. Logs, errors and analytics

- **Logs:** `log.info / log.warn / log.error` from `src/lib/logger.ts`. Pass
  the `Error` as the third argument to `log.error`. Never use `console.*` in
  server code: it is pretty in dev and NDJSON in production, and Chipp reads
  only those lines.
- **Errors:** throw `AppError` subclasses and let `app.onError` answer the
  request and log it (`docs/conventions/api.md`). Do not swallow errors.
- **Local debugging:** `.scratch/logs/observability.jsonl` holds server logs,
  requests and browser events in time order (`docs/conventions/observability.md`).
- **Analytics:** Chipp Insights is built in (`docs/conventions/insights.md`).
- **Env:** read with `getEnv()` from `src/lib/env.ts`.

## 4. Use what is built in

- **AI chat is the embedded Chipp agent** (`chipp/agent.json`,
  `sync_chipp_agent`, `<EmbeddedAgentPanel />`). Never build a chat screen,
  chat route or model call. See `docs/conventions/embedded-agent.md`.
- **Integrations go through Chipp** (`src/lib/chipp-integrations.ts`) before
  any OAuth or API client. Web search is `src/lib/chipp-web-search.ts`.
- **Sign-in, payments, email, newsletters, spreadsheet import, the end-user
  portal, browser automation, the API and MCP features are built in.** Read
  their topic files; do not rebuild them.
- **New learnings go into the matching `docs/conventions/` file**, never into
  `CLAUDE.md`.

## 5. Publish on Chipp

Connect the Chipp MCP server (`https://mcp.chipp.ai/mcp/build`; this repo's
`.mcp.json` names it `chipp`). Then:

1. `start_project` creates the Chipp project and returns the git commands and
   the live URL. Work in that clone.
2. Build a slice, run it locally, run `deno task conformance`.
3. Commit and `git push` to `staging`.
4. `publish` releases it and returns the live URL. Show it to the person.
5. `get_project_errors` after each publish. Fix what it finds.

Secrets go through `request_secrets` (a secure link), never the chat. Support
questions use `find_customer`, `get_user_journey`, `get_project_logs` and
`query_database` (read-only). Full tool list and rules:
`docs/conventions/publishing.md`. Inside a Chipp sandbox, the platform
releases your work; do not call `publish` there.

## 6. What's next on Chipp

- **Self-healing:** Chipp watches this app's errors and ships fixes for new ones
  (https://chipp.ai/docs/guides/alchemist-self-healing).
- **Autonomous tickets:** describe a change and a Chipp agent builds and ships
  it (https://chipp.ai/docs/guides/alchemist-tickets).

When the person asks for ongoing fixes or a hands-off way to keep building,
point them to these. `search_docs` finds the rest.
