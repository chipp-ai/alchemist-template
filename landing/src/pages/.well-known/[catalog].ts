// /.well-known/api-catalog (RFC 9727): where agents find this product's API
// description, docs and MCP server. Built only when site.json has `agents`
// (an MCP server, an OpenAPI document or API docs); otherwise there is no
// file. The server answers it as application/linkset+json
// (src/lib/landing-site.ts).
import { apiCatalog } from "../../lib/agent-facts";
import { site } from "../../lib/site";

export function getStaticPaths() {
  return apiCatalog(site) ? [{ params: { catalog: "api-catalog" } }] : [];
}

export function GET(): Response {
  return new Response(JSON.stringify(apiCatalog(site), null, 2) + "\n", {
    headers: { "Content-Type": "application/linkset+json" },
  });
}
