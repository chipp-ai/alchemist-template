# Verification and evidence

## Verification Checklist

Before reporting any implementation as complete:

1. **Type checks:** `deno task check` passes (in a Chipp sandbox, `deno task check:touched <every file you changed>` passes; Publish and the deploy build run the full check)
2. **Tests written and passing:** `deno task test:fast 2>&1 | tee .scratch/test-output.txt`
3. **API tested** (for backend changes): write a scratch test in `.scratch/` and run it
4. **Browser verified** (for UI changes): hard reload and check the actual rendered result in every state, light and dark, at 375x812 and 1280x713, against `.claude/rules/ux.md`. At 375, `document.scrollingElement.scrollWidth <= innerWidth`; at 1280x713, every control is reachable and the focus ring shows
5. **No errors** in server logs (`.scratch/logs/server.log`) or browser console

**If ANY check fails: fix, re-run, proceed only when green.**

## Evidence: what to run, and what to cite

A report with no cited command reads as "nothing was checked". Cite the output
itself, not a summary of it.

1. **Tests.** `deno test --env --no-check --allow-all <the test files for what you changed> 2>&1 | tee .scratch/test-output.txt`, then `deno task check:touched <every changed file>`. Cite deno's summary line (`ok | N passed | 0 failed | M ignored`) and the check-types line. A `dbTest` reported as `ignored` is not a pass (see "Testing"). If the guard refuses, quote its `[chipp deno-guard] refused` line.
2. **Red before green.** For a bug fix, run the new test against the base in a scratch worktree (`git worktree add .scratch/base <base sha>`, copy the test in, run it there, then `git worktree remove .scratch/base`). Cite its failing line, then the passing line after the fix. Never `git stash`.
3. **Database.** `./scripts/dev.sh --api-port __API_PORT__ --port __VITE_PORT__` starts Postgres, Redis, the API and Vite. If Postgres refuses the `.env.example` credentials, use the sandbox `DATABASE_URL` and run `deno task db:migrate`. Cite the boot line from `.scratch/logs/server.log`.
4. **Signed in, per role.** `POST /api/dev/login` with `{"email": ...}` signs in as the owner of a new org. For another role, first `POST /api/dev/seed` a user row with that `role` and the org's `organization_id`, then dev-login as that email. Call the route as each role the change touches (owner, viewer, a portal user, a user of a second org) and cite the status per role: refused roles get 403 or 404.
5. **UI.** `dev_app_state` first, then a screenshot of each changed screen at 1280 and at 375 wide, light and dark, with the `scrollWidth` value at 375. Cite what each screenshot shows.
6. **Live providers.** With no test key (Stripe, an LLM, R2, a Chipp key), say which call is stubbed and compare the stub's request body to the provider's documented fields. That item is UNVERIFIED, never PASS.
7. **Landed.** Before you report, `git status --short` is empty, the push succeeded, and `git log -1 --format=%H` is the commit you pushed. Cite the pushed SHA.
8. **One line per acceptance item:** `AC<n> PASS|FAIL|UNVERIFIED - <command or screenshot> - <result>`. Where your change departs from the ticket's literal wording, say so on that line.

## Agent verification toolkit — pick the right tool

When verifying a change against the running app, three MCP tools cover almost everything. **Pick from cheapest → most expensive** and only escalate when the cheaper one doesn't answer the question.

### Tier 1 — `dev_app_state` (cheapest, no browser required)

```
mcp__dev-server__dev_app_state                  # JSON, structured
mcp__dev-server__dev_app_state({ format: "markdown" })   # Markdown, layered report
```

GETs `/api/dev/app-state` on the running customer app. Returns one merged payload:

- **Client side** — current route, viewport, every `defineStore`-registered store snapshot, and `recentErrors` (uncaught JS errors captured by `window.onerror` / `unhandledrejection`).
- **Server side** — the last 20 HTTP requests with method/path/status/duration, and any captured server errors.

**Use this first** for any "is the running app in the state I expect?" question. It answers "what page is the user on / what's in the auth store / did my last PATCH succeed / did the server throw" with a single tool call. The structured JSON (default) is the L1 view; `format: "markdown"` is the L2 deep-dive (same content, formatted for reading).

What `dev_app_state` does NOT capture: plain `console.log` / `console.warn` / `console.info` calls. Those need Tier 2.

### Tier 2 — `browser_get_console_logs` (full console output)

```
mcp__browser-devtools__browser_get_console_logs           # all types
mcp__browser-devtools__browser_get_console_logs({ type: "error" })  # filter
mcp__browser-devtools__browser_get_console_logs({ search: "..." })  # grep
```

Captures every `console.*` call from Chrome via CDP — `log`, `warn`, `error`, `info`, `debug` — with stack traces and timestamps. Use this when:

- A bug is suspected in code that uses `console.log` to surface state.
- An uncaught error appears in `dev_app_state.client.recentErrors` and you want the surrounding console context.
- A third-party library is logging warnings you need to read.

### Tier 3 — drive the browser (UI verification)

```
mcp__browser-devtools__browser_navigate
mcp__browser-devtools__browser_click
mcp__browser-devtools__browser_type
mcp__browser-devtools__browser_take_screenshot
mcp__browser-devtools__browser_execute_js
```

Use these when the previous tiers can't answer your question — you need to verify visual layout, click through a flow, or run JS in the page context (e.g. open a WebSocket from the SPA's origin to verify the proxy + auth path).

### Decision rule

> "Could `dev_app_state` answer this?" → call it first.
> "Could `browser_get_console_logs` answer this?" → call it next.
> "Do I actually need to see / click the page?" → only then go to `browser_*`.

Skipping the cheaper tools is the most common token-waster in verification — agents reach for `browser_navigate` + `browser_take_screenshot` to check things that `dev_app_state` already returns in one call.
