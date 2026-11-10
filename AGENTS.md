# AGENTS.md

Read `CLAUDE.md` first: it is this repository's index, with the hard rules and
one line per topic file in `docs/conventions/`. The rules that most often go
wrong:

- **Chat with AI is the embedded Chipp agent.** Any feature where a person
  types to the AI and reads its replies uses `chipp/agent.json`,
  `sync_chipp_agent` and `<EmbeddedAgentPanel />`. Never build a chat
  screen, chat route or conversation model call. See
  `docs/conventions/embedded-agent.md`.
- **Integrations go through Chipp.** Use the hosted integration broker
  (`src/lib/chipp-integrations.ts`) before writing any OAuth or API client.
- **Email, browser automation, API and MCP features are built in.** Use
  them; do not rebuild them. See their files in `docs/conventions/`.
- **New learnings go into the matching `docs/conventions/` file**, never into
  `CLAUDE.md`.
