# Chat with AI and embedded agent tools

## Chat with AI: it is the embedded Chipp agent (do NOT rebuild it)

Any feature where a person types to the AI and reads its replies is this
app's embedded Chipp agent: a chat, an assistant, a coach, a tutor, a
helper, "ask the docs", Q&A. **Never build a chat screen, a message list,
a chat route, a conversation store, or a model call that runs a
conversation, not even as a placeholder.** Chipp hosts the agent, its
instructions, its knowledge, its memory and its billing.

1. Call `get_embedded_chipp_agent_status`. If there is no agent, write
   `chipp/agent.json` (name, instructions, welcome, knowledge, contextKeys,
   surfaces) and the markdown under `chipp/knowledge/`, then call
   `sync_chipp_agent`. It creates the agent.
2. If the result says the pack landed, `git fetch origin && git merge
   origin/<base branch>` to get `web/src/lib/embedded-agent/`.
3. Place `<EmbeddedAgentPanel context={...} />` on the pages where it
   helps, or `<EmbeddedAgentWidget />` once in `App.svelte`. Send only
   context keys listed in `contextKeys`, never personal data.
4. Give it this app's data through agent tools (next section).

The agent can already search the web, make images and videos, run deep
research, and (when switched on) take voice and file uploads. Turn these on
or off with `"capabilities"` in `chipp/agent.json`, then call
`sync_chipp_agent`: `webSearch`, `imageGeneration`, `videoGeneration`,
`deepResearch`, `voice`, `fileUploads` (each `true` or `false`; a missing
key leaves the agent's setting alone). Images and videos show in the chat
on their own. A `deepResearch` reply can take a few minutes. If the sync
ever says the plan blocks a switch, tell the person; never build a
workaround. Never build
your own image, video, search, research, voice or upload feature for the
chat. Full table: `docs/agent-guidance/embedded-chipp-agent.md`.

`llmMessages` / `llmStructured` (`src/services/llm/`) are for one-shot
server tasks with no conversation: extract, classify, summarize, draft one
text. Never import an AI provider SDK, call a provider's API host, or ask
for `OPENAI_API_KEY` / `ANTHROPIC_API_KEY`.
`src/__tests__/no-custom-ai-chat.test.ts` fails the build when code does.

## Embedded agent tools: register them for every feature

Every app ships an embedded Chipp agent. It reads and changes this app's
data through tools, acting as the signed-in user and never as anyone else.
**When you build a feature, register agent tools for its routes in
src/services/agent-tools/, scoped by the session user's organization; mark
writes write:true; never accept org or user ids from tool args; never add
raw SQL tools.**

| Piece | File |
|---|---|
| Registry (`registerAgentTool`) | `src/services/agent-tools/registry.ts` |
| Starter tools (**copy this file**) | `src/services/agent-tools/starter-tools.ts` |
| Tool module list | `src/services/agent-tools/index.ts` (import each new tools file here) |
| Agent token (`mintAgentToken`, `verifyAgentToken`) | `src/services/agent-tools/agent-token.ts` |
| Auth gate (`requireAgentAuth`) | `src/api/middleware/agent-auth.ts` |
| Endpoint `POST /api/agent-mcp` | `src/api/routes/agent-mcp/index.ts` |
| Session proxy helper (`embeddedAgentSessionExtras`) | `src/services/embedded-agent/session-extras.ts` |

```ts
registerAgentTool({
  name: "list_orders",
  description: "List this workspace's orders, newest first.",
  inputSchema: { type: "object", properties: { limit: { type: "integer", minimum: 1, maximum: 100 } } },
  capability: "app.read",          // a roles.ts capability, checked on every list and call
  write: false,                    // true for anything that changes data
  handler: ({ user }, args) =>
    listOrders({ organizationId: user.organizationId, limit: args.limit ?? 25 }),
});
```

How it fits together: the embedded-agent session proxy mints a 15-minute
agent token for the signed-in user and sends it to Chipp with
`embeddedAgentSessionExtras(user)`. The Chipp runtime calls
`POST /api/agent-mcp` (MCP over JSON-RPC) with `Authorization: Bearer
<agentToken>`. The gate re-reads the user, so the current role, the current
org and logout-all apply.

The tools work in the Builder preview too. There `APP_URL` is
`http://localhost:8000`, so the session proxy sends that URL; Chipp maps it to
this sandbox and calls the endpoint through the sandbox's own tunnel. Do not
change `APP_URL` for this. To check a tool, sign in to the preview and ask the
agent widget a question that needs the data.

Invariants:

- **Scope by `ctx.user`, never by an argument.** The org comes from
  `user.organizationId`; personal data from `user.id`. Registration throws
  on an argument named like `organizationId` or `userId`, and unknown
  arguments are refused at call time.
- **A row id argument is fine; the service query still carries the org in
  its WHERE clause.** Another org's id must be a "not found".
- **Writes are `write: true`.** They are advertised with
  `destructiveHint: true` and `_meta["chipp/requiresConfirmation"]`, so the
  Chipp runtime asks the person before calling.
- **Pick the capability the matching route uses.** tools/list shows a tool
  only to roles that have it.
- **Portal viewers see only `portalSafe: true` tools.** Mark a tool portal
  safe only when it scopes by `ctx.portalBindings` or `ctx.user.id`.
- **No raw SQL, no "run a query" tools.** Registration refuses the names.
- **Scoped tokens stay scoped.** An agent token is never a session (the
  session verifier refuses any token with `scope` or `aud`), and a session
  or WS token never reaches the tools. Agent tokens need `JWT_SECRET`;
  there is no development fallback.
- **Test cross-tenant reads for every new tool**: a user of org A passing
  org B's ids gets nothing of B's. `src/__tests__/routes/agent-mcp.test.ts`
  shows the pattern.
