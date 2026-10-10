/**
 * What the embedded-agent session proxy adds to its Chipp mint request so
 * the agent can read and change this app's data AS the signed-in user.
 *
 * The embedded-chipp-agent pack renders src/services/embedded-agent/
 * router.ts. Its authenticated `POST /session` route spreads this into the
 * body it sends to Chipp's POST /api/client/embed/session:
 *
 *   const extras = await embeddedAgentSessionExtras(user);
 *   body: { ...identity, ...extras }
 *
 * `agentToken` is a 15-minute, user-scoped token (scope "agent", aud
 * "chipp-embed"); `agentToolsUrl` is this app's MCP endpoint. The Chipp
 * runtime calls the tools with the token as a bearer credential.
 *
 * Never call this for an anonymous session: there is no user to act for.
 *
 * Fail closed, but never break the chat: when JWT_SECRET is unset the
 * helper logs an error and returns `{}`, so the chat session still mints
 * and the agent simply has no tools.
 */

import type { AuthUser } from "@/api/middleware/auth.ts";
import { AgentTokenConfigError, mintAgentToken } from "@/services/agent-tools/agent-token.ts";
import { appOrigin } from "@/services/app-links.ts";
import { log } from "@/lib/logger.ts";

export const AGENT_TOOLS_PATH = "/api/agent-mcp";

export interface EmbeddedAgentSessionExtras {
  agentToken: string;
  agentToolsUrl: string;
}

export async function embeddedAgentSessionExtras(
  user: Pick<AuthUser, "id" | "organizationId" | "role">,
): Promise<EmbeddedAgentSessionExtras | Record<never, never>> {
  try {
    return {
      agentToken: await mintAgentToken(user),
      agentToolsUrl: `${appOrigin()}${AGENT_TOOLS_PATH}`,
    };
  } catch (err) {
    if (err instanceof AgentTokenConfigError) {
      log.error("Embedded agent: agent tools disabled, JWT_SECRET is not set", {
        source: "embedded-agent",
        feature: "session-extras",
      }, err);
      return {};
    }
    throw err;
  }
}
