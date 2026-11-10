# [Project Name]

[Brief description of what this SaaS product does -- CUSTOMIZE THIS for your product]

**Powered by Alchemist AI** -- Autonomous development platform.

## How this file works

This file is the index: the hard rules, the commands, and one line per topic.
Each topic lives in `docs/conventions/<topic>.md`. Read a topic file before
you work in its area; do not read them all. Path-scoped rules in
`.claude/rules/` load by themselves when you touch a matching file (the table
is in `docs/conventions/rule-spokes.md`).

**New learnings go into the matching `docs/conventions/` file, never into this
file.** After a correction, write the rule that prevents the mistake into the
topic file it belongs to. When no topic fits, add a new
`docs/conventions/<topic>.md` and one line for it in "Topics" below. This file
has a budget of 16,000 characters; `src/__tests__/claude-md-budget.test.ts`
fails CI above it.

## Writing style

Write in Simplified Technical English (ASD-STE100), following Zinsser's four
principles: simplicity, brevity, clarity, humanity.

- Short sentences. One idea each.
- Active voice.
- One meaning per word. Pick a term and keep it; do not rename the same thing
  mid-answer.
- Cut the clutter. Lead with the answer. No preamble, no restating the task
  before giving the result.
- Warm and human. A person wrote it, not a manual.
- No em dashes. No all caps for emphasis.

Concision is not terseness. Keep anything that changes what the reader decides:
a caveat, a cost, a risk, something you did NOT verify. Cut the words that do
not. A short answer that hides a caveat is worse than a longer one that
surfaces it.

Applies to responses, commit messages, docs, and phase reports alike.

## Local Dev Ports

@.claude/local-dev.md

All references to `__VITE_PORT__` and `__API_PORT__` in docs mean **your** Vite and API ports from the file above.

## Quick Start

```bash
./scripts/setup.sh                                          # First time only
./scripts/dev.sh --api-port __API_PORT__ --port __VITE_PORT__  # Start dev stack
```

**Browser:** Always use `http://localhost:__VITE_PORT__` (Vite), NOT the API port.

**HMR is disabled.** Multiple agents build concurrently on the same repo. Frontend changes require a **hard reload** in the browser (Cmd+Shift+R). Do not wait for HMR -- it will not pick up changes.

**Dev login (local browser testing):** there is no SMTP / inbox harness in dev, so the email-OTP code never reaches an inbox — sign-in via the OTP form will always block. Two well-lit escape hatches:

- **In the browser**, the Login page renders a "Dev login as ..." button below the OTP form (visible only when `import.meta.env.DEV`). It POSTs to `/api/dev/login`, sets a real session cookie, and redirects in. This is the path for human / interactive testing.
- **From an agent or terminal**, `curl -X POST -H 'Content-Type: application/json' -d '{"email":"agent@dev.local"}' http://localhost:__API_PORT__/api/dev/login -c /tmp/jar.txt` issues the same session. Re-use the cookie jar with `-b /tmp/jar.txt` on subsequent requests.

The `/api/dev/*` routes 404 when `NODE_ENV=production`, and the Login page button is stripped from production SPA builds — both surfaces are local-only by construction. The full route catalog (seed / reset / introspect) is in `docs/conventions/dev-affordances.md`.

## Commands

```bash
deno task test:fast 2>&1 | tee .scratch/test-output.txt   # routes + services, about a minute
deno task test 2>&1 | tee .scratch/test-output.txt        # every test
deno test --env --no-check --allow-all <file>             # one file
deno task check                                           # type-check the app
deno task check:tests                                     # type-check src/__tests__/
deno task check:touched <file> [more files]               # the files you changed (up to 20)
deno task lint && deno task fmt
deno task db:migrate
```

Capture test output to `.scratch/test-output.txt` and grep the file instead of
re-running. Type checks run the native TypeScript 7 compiler and the Chipp
sandbox runs `deno` under a memory guard: see `docs/conventions/testing.md`.

## Critical Rules

- **`staging` IS production.** The `staging` branch serves real users. PRs target `staging`, never `main`.
- Never make things up. Ask if unsure. No emojis unless necessary.
- Use `.scratch/` for ephemeral files (test scripts, debug logs, scratch data).
- **Run `deno task check:tests` after touching ANY test file.** CI type-checks `src/__tests__/`; local runs use `--no-check`, so a type error in a test passes locally and reds CI.
- **Type-check the files you changed** with `deno task check:touched <file> [more files]` before you finish. Outside a Chipp sandbox, `deno task check` checks the whole app.
- **In a Chipp sandbox, run the tests that cover every file you touched and cite deno's summary line** (`ok | N passed | 0 failed | M ignored`). A whole-repo check is refused there by the memory guard; that is the sandbox, not a fault. If the guard refuses a test run, quote its `[chipp deno-guard] refused` line; never write "tests not run" without it.
- **Kysely aggregates take columns from the query's builder, never `db.fn`:** `.select((eb) => [eb.fn.max("col").as("x")])`. `src/__tests__/kysely-unscoped-db-fn.test.ts` fails on the bare form.
- **Change project files, not base files, to make a feature work.** `app.ts`, `web/src/components/Sidebar.svelte`, `src/api/routes/auth/index.ts`, `web/src/routes.ts` and `db/migrate.ts` / `db/_runner.ts` are the template's. Use the hooks they expose (`recipe-routes.ts`, `chipp-app.json`, registries). Never import template code from a moving URL; pin a commit SHA, or copy the file.
- **Tests that create DB resources use `createIsolatedUser()`**, never the shared test user.
- **NEVER use `--no-verify` or `--no-gpg-sign`** on any git command. If hooks fail, fix the cause.
- **Every interactive element gets `data-testid`** as `{area}-{component}-{element}` (e.g. `settings-form-input-name`).
- **Start the dev stack only with `./scripts/dev.sh --api-port __API_PORT__ --port __VITE_PORT__`.** Logs go to `.scratch/logs/`.
- **Read env with `getEnv()` from `src/lib/env.ts`, never `Deno.env.get()`, in server code.** In tests use `__setEnvForTest()` / `__deleteEnvForTest()`. `src/__tests__/env-isolation.test.ts` fails CI on direct `Deno.env` use.
- **Third-party integrations go through the Chipp hosted-integration broker first** (`src/lib/chipp-integrations.ts`). Never build a bespoke OAuth connector or ask for provider secrets for a provider the platform hosts. Live web data uses `src/lib/chipp-web-search.ts`; never ask for a search API key. Details: `docs/conventions/integrations.md`.
- **Chat with AI is the embedded Chipp agent** (`chipp/agent.json`, `sync_chipp_agent`). Never build a chat screen, chat route or conversation model call.
- **Built-in features are used, never rebuilt:** Stripe selling, inbound and outbound email, newsletters, spreadsheet import, the end-user portal, browser automation, social login, the API and MCP features. Read the topic file first.
- **Never hand-roll regex or keyword heuristics to judge natural language.** Call a small model with structured outputs and fail closed. Regex is only for syntactic input.
- **Background work is gated on `WORKER_ROLE`** (`docs/conventions/background-work.md`).
- **JSONB: never pass a pre-stringified value as a parameter** (`docs/conventions/database.md`).

## Topics

Read the file before you work in that area.

| File (`docs/conventions/`) | Read it when you |
|---|---|
| `architecture.md` | need the folder layout and the stack |
| `engineering-preferences.md` | review or design code (DRY, tests, explicit over clever) |
| `rule-spokes.md` | want the table of `.claude/rules/` spokes and their globs |
| `api.md` | add or change a Hono route, validation, the response envelope, error handling |
| `database.md` | write a migration or a Kysely query, or store JSONB |
| `redis.md` | cache, lock, rate-limit or dedupe |
| `events.md` | publish or consume a domain event, or add an outbound webhook |
| `background-work.md` | add a job, a cron or a loop |
| `testing.md` | write or run tests, type checks, or read env in code or tests |
| `verification.md` | finish a change: the checklist, the evidence to cite, the verification tools |
| `dev-affordances.md` | need dev login, seed, reset or introspection routes |
| `observability.md` | debug locally (`.scratch/logs/observability.jsonl`) or a deployed app (MCP tools) |
| `frontend.md` | touch Svelte pages, routing, modals, stores, `createQuery`, or the Mobile and touch rules (tokens and motion: `web/DESIGN.md`) |
| `brand-and-design.md` | change the brand, `design.json`, or start a new project's look |
| `built-in-sections.md` | switch a built-in section in `web/src/chipp-app.json`, or `DEMO_MODE` |
| `landing-site.md` | change the public site in `landing/` or the homepage at `/` |
| `auth.md` | touch sign-in codes (OTP), social login or SSO |
| `hipaa.md` | work on a HIPAA-mode project |
| `files.md` | store, upload or name files |
| `spreadsheet-import.md` | import spreadsheets or CSV |
| `payments.md` | sell anything (built-in Stripe, Chipp Payments) |
| `api-mcp-features.md` | expose the app's API or MCP server |
| `embedded-agent.md` | add AI chat, or register agent tools for a feature |
| `integrations.md` | connect a third-party service or use live web search |
| `email.md` | receive email, send email, or schedule email |
| `newsletters.md` | send newsletters or bulk email |
| `portal.md` | give end users (customers of the app) their own portal |
| `browser-automation.md` | scrape or automate a third-party website |
| `library-idioms.md` | write Deno 2, Hono 4, Arctic 2, date-fns 3 or Stripe 17 code |
| `insights.md` | touch analytics or the Chipp Insights beacon |
| `git.md` | commit (always `git add -A`; never stash) |
| `pitfalls.md` | want the list of mistakes that already happened here |
