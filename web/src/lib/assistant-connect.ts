/**
 * How each AI assistant connects to this app's MCP server. Zero
 * dependencies, so a Deno test can pin the links.
 *
 * Verified against each vendor's docs on 2026-11-12:
 *
 * - Claude: an install link opens the "Add custom connector" dialog with
 *   the name and URL filled in; the person confirms.
 *   https://claude.com/docs/connectors/building/directory-vs-custom
 *   https://claude.com/docs/connectors/custom/add-unlisted
 * - ChatGPT: no link fills the form. The person adds a custom MCP server at
 *   chatgpt.com/plugins. Plan and workspace policies apply.
 *   https://developers.openai.com/apps-sdk/deploy/connect-chatgpt
 * - Grok: no link fills the form. The person adds a custom connector at
 *   grok.com/connectors. On Grok Business and Enterprise an admin adds it
 *   first. https://docs.x.ai/grok/connectors
 *
 * Every client signs in through this app's own login (MCP OAuth), so each
 * person connects as themselves with their own role.
 */

/** GET /api/assistants. */
export interface AssistantsInfo {
  enabled: boolean;
  appName: string;
  mcpUrl: string | null;
}

export type AssistantId = "claude" | "chatgpt" | "grok";

export interface AssistantTarget {
  id: AssistantId;
  label: string;
  /** Button text. */
  action: string;
  /** True when the link fills in the URL itself; false means copy first. */
  prefills: boolean;
  /** One line of steps, shown under the button. */
  steps: string;
  url: (connector: { name: string; mcpUrl: string }) => string;
}

/** Public guide for this panel. */
export const ASSISTANTS_DOCS_URL =
  "https://chipp.ai/docs/guides/software-factory-use-with-claude-chatgpt-grok";

export const ASSISTANT_TARGETS: readonly AssistantTarget[] = [
  {
    id: "claude",
    label: "Claude",
    action: "Add to Claude",
    prefills: true,
    steps: "Claude opens with this app filled in. Select Add, then Connect, and sign in. " +
      "On Claude Team or Enterprise, an owner adds it first.",
    url: ({ name, mcpUrl }) =>
      "https://claude.ai/customize/connectors?modal=add-custom-connector" +
      `&connectorName=${encodeURIComponent(name)}&connectorUrl=${encodeURIComponent(mcpUrl)}`,
  },
  {
    id: "chatgpt",
    label: "ChatGPT",
    action: "Copy URL and open ChatGPT",
    prefills: false,
    steps: "Select +, then Add custom MCP server. Paste the URL, choose OAuth, and sign in. " +
      "Your ChatGPT plan and workspace settings decide if this is available.",
    url: () => "https://chatgpt.com/plugins",
  },
  {
    id: "grok",
    label: "Grok",
    action: "Copy URL and open Grok",
    prefills: false,
    steps: "Select New Connector, then Custom. Paste the URL and sign in. " +
      "On Grok Business or Enterprise, an admin adds it first.",
    url: () => "https://grok.com/connectors",
  },
];

/** Public guide for platform members and app roles (Team tab). */
export const SHARING_DOCS_URL = "https://chipp.ai/docs/guides/software-factory-sharing-and-roles";
