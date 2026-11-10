# Observability and production debugging

## Observability stream — `.scratch/logs/observability.jsonl`

Every server log statement, HTTP request, server error, AND every browser-side breadcrumb (console.*, errors, fetch/XHR, clicks, route changes, LCP/CLS/INP) converges in **time order** into a single JSONL file at `.scratch/logs/observability.jsonl`. This is the canonical "what happened during this test session" stream — read it after a user has poked at the app to understand exactly what they did, what fired, and what failed.

Each line is `{ts, sid, source: "client"|"server", kind, data}`. Stable `kind` slugs (do NOT mutate; analytics product depends on them): `server.log.{debug,info,warn,error}`, `server.http`, `server.error`, `client.console.{log,info,warn,error,debug}`, `client.error`, `client.promise`, `client.fetch`, `client.click`, `client.click.background`, `client.route`, `client.perf.{lcp,cls,inp}`, `client.session`.

Implementation lives in:
- `src/observability/jsonl-writer.ts` — append-only writer with 10MB rotation
- `src/observability/envelope.ts` — `recordServerEvent` / `recordClientEvents`
- `src/api/routes/observability/index.ts` — `POST /api/_observability/breadcrumb` collector
- `web/src/lib/observability/breadcrumbs.ts` — client-side hooks (installed from `web/src/main.ts`)
- Hooked into `src/lib/logger.ts` (every emit) and `src/lib/dev-activity.ts` (every recorded request + error)

Dev-only — the entire pipeline no-ops when `NODE_ENV === "production"`. The analytics product will replace the collector with a remote ingest at that boundary when it ships.

**When debugging a user-reported issue, tail this file first** — `tail -n 200 .scratch/logs/observability.jsonl | jq .` gives the most recent slice of what happened in their session, both client and server, in time order.

## Production debugging -- Alchemist MCP tools (`.mcp.json`)

The observability stream above is dev-only. To debug the DEPLOYED app, this repo ships a `.mcp.json` that connects Claude Code (or any MCP client) to the Alchemist platform's tenant MCP endpoint. Before launching Claude Code, export your tenant API key in the shell:

```bash
export ALCHEMIST_API_KEY=alch_...   # from the Alchemist dashboard; NEVER commit it
```

The config expands `${ALCHEMIST_API_KEY}` at connect time. All tools are tenant-scoped: they only see YOUR projects.

| Tool | Use for |
|------|---------|
| `get_project_errors` | Error-level logs from the deployed app (5m-7d lookback, pattern filter) |
| `get_project_logs` | General log search: error/warn/info levels, pattern filter, capped results |
| `query_database` | Read-only SQL against this project's production database (SELECT-only, row-capped, statement timeout) |
| `get_env_status` | Which required env vars are set on the deployed app |
| `get_alert_status` | Whether an error-investigation agent is already active |
| `dispatch_ticket`, `list_tickets`, `get_ticket`, `get_ticket_reports` | Hand work to the autonomous pipeline instead of doing it by hand |

Routing rule: a LOCAL issue → tail `.scratch/logs/observability.jsonl` (section above). A DEPLOYED-app issue → `get_project_errors` / `get_project_logs` first, then `query_database` to inspect data. A fix you'd rather not hand-write → `dispatch_ticket`.

The production database is reachable ONLY through `query_database` (read-only). There are no direct production DB credentials to configure locally, and you should never ask for any. If `get_project_logs` or `query_database` is missing from the tool list, your platform hasn't rolled them out yet -- fall back to `get_project_errors` and `dispatch_ticket`.
