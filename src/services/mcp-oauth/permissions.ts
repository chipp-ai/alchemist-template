/**
 * MCP OAuth scopes.
 *
 * The starter ships a deliberately small vocabulary:
 *   tools:read   -- list tools, call read-only tools
 *   tools:write  -- call tools that mutate state
 *
 * Write implies read (normalizeMcpScopes expands it). Extend by appending to
 * ALL_MCP_SCOPES; the consent page and discovery metadata pick new scopes up
 * automatically. Enforce scopes inside tool handlers (or the dispatch layer)
 * via the auth context's `scopes` array.
 */

export const ALL_MCP_SCOPES = ["tools:read", "tools:write"] as const;
export type McpScope = (typeof ALL_MCP_SCOPES)[number];

/**
 * Normalize a scope list (string or array): drop unknown scopes, dedupe,
 * expand write-implies-read. An EMPTY result defaults to all scopes -- MCP
 * clients frequently omit `scope` entirely, and the consent screen is the
 * real grant boundary for this single-resource server.
 */
export function normalizeMcpScopes(raw: string | string[] | unknown): string[] {
  const requested = Array.isArray(raw)
    ? raw.filter((s): s is string => typeof s === "string")
    : typeof raw === "string"
    ? raw.split(/[\s,]+/).filter(Boolean)
    : [];

  const known = new Set<string>();
  for (const scope of requested) {
    if ((ALL_MCP_SCOPES as readonly string[]).includes(scope)) known.add(scope);
  }
  if (known.has("tools:write")) known.add("tools:read");
  if (known.size === 0) return [...ALL_MCP_SCOPES];
  return [...known].sort();
}
