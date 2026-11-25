# Publishing on Chipp from your own AI tool

Read this file when you build this app in your own coding agent (Claude
Code, Codex, Cursor, Hermes, VS Code, opencode) and want it live on Chipp.
Inside a Chipp sandbox (the Builder or a ticket), the platform releases your
work, so do not call these tools there.

## Connect the Chipp MCP server once

The `build` toolset is one URL: `https://mcp.chipp.ai/mcp/build`. This repo's
`.mcp.json` already names it as `chipp`, so Claude Code offers it in this
folder. Other tools:

```bash
claude mcp add --transport http --scope user chipp https://mcp.chipp.ai/mcp/build
codex mcp add chipp --url https://mcp.chipp.ai/mcp/build && codex mcp login chipp
```

Cursor (`~/.cursor/mcp.json`): `{"mcpServers":{"chipp":{"url":"https://mcp.chipp.ai/mcp/build"}}}`.
Hermes (`~/.hermes/config.yaml`): `mcp_servers: { chipp: { url: "https://mcp.chipp.ai/mcp/build", auth: oauth } }`.

The first call opens a browser tab. The person signs in with an email code.
No API key goes in a file or the chat.

## The tools

| Tool | Use it to |
|---|---|
| `start_project` | create the Chipp project for this app (a free software factory project). It returns the project id, the live URL and two git commands. Run them in your shell; never print the credential |
| `get_git_access` | get a fresh git credential (an expired one, or a second machine) |
| `publish` | release the pushed `staging` head to the live URL and wait for it. Returns the URL, the deploy id and any conformance warnings |
| `get_project_release_status`, `rollback_project_deploy` | see what is live; put the previous release back |
| `request_secrets`, `get_secret_status`, `get_env_status` | ask for API keys with a secure link; check what is set |
| `get_project_errors`, `get_project_logs`, `get_project_analytics` | errors, log search and Insights for this app |
| `find_customer`, `get_user_journey` | look up one of the app's users and what they did |
| `inspect_schema`, `query_database` | read-only SQL on the production database |
| `search_docs` | Chipp docs and this template's guides |

Every tool except `start_project` takes the `project_id`. When Chipp created
this clone, the id is in `.chipp/project.json`.

## The loop

1. Build one slice. Run it locally (`./scripts/setup.sh`, then
   `./scripts/dev.sh`; see `CLAUDE.md` "Quick Start").
2. Run `deno task conformance`. Fix every error (`stack-and-conformance.md`).
3. `git add -A && git commit && git push` to `staging` on the Chipp remote.
   The push builds the app but does not release it.
4. Call `publish`. Give the person the live URL.
5. Call `get_project_errors` and fix what it finds.

Publish the first slice early, so the URL exists from the start.

## Rules

- Secrets: always `request_secrets`. Never ask the person to paste a secret
  into the chat, `.env` or a committed file.
- The production database has no direct credentials. Read it with
  `query_database`. Change it with a migration in `db/migrations/`. The
  migration runs on deploy.
- A failed build names the cause in the `publish` result. A
  `Template conformance failed:` cause means the stack changed: undo it.
- If a `build` tool is missing from your tool list, say so to the person and
  stop. Do not deploy anywhere else.

## What comes next on Chipp

- **Self-healing:** Chipp watches the app's errors and opens a fix ticket for
  each new one, then ships the fix. It works on every plan, and it is off until the owner
  turns it on. It works because the app logs through
  `src/lib/logger.ts`. Docs: https://chipp.ai/docs/guides/alchemist-self-healing
- **Autonomous tickets:** describe a change or a bug, and a Chipp agent builds,
  tests and ships it in its own sandbox. Tickets come with the Studio Pro
  plan. Docs:
  https://chipp.ai/docs/guides/alchemist-tickets
- The same project opens in the Chipp Builder at https://build.chipp.ai.
