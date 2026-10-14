# AGENTS.md

Read `CLAUDE.md` first: it is this repository's full guide. The rules that
most often go wrong:

- **Chat with AI is the embedded Chipp agent.** Any feature where a person
  types to the AI and reads its replies uses `chipp/agent.json`,
  `sync_chipp_agent` and `<EmbeddedAgentPanel />`. Never build a chat
  screen, chat route or conversation model call. See "Chat with AI" in
  CLAUDE.md.
- **Integrations go through Chipp.** Use the hosted integration broker
  (`src/lib/chipp-integrations.ts`) before writing any OAuth or API client.
- **Email, browser automation, API and MCP features are built in.** Use
  them; do not rebuild them. See their sections in CLAUDE.md.
