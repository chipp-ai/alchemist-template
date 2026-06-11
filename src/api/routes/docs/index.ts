/**
 * In-app Docs API — auth-gated.
 *
 *   GET /api/docs            — { pages: [{slug,title,group,summary}] } for the TOC.
 *   GET /api/docs/search?q=  — { results: DocSearchResult[] } semantic search.
 *   GET /api/docs/:slug      — { page: DocPage } one page incl. its markdown body.
 *
 * Docs are internal: every route requires a signed-in user (any org/role).
 * There is no public bypass. The content is static (shipped in the image
 * via the registry); search is served from the boot-built index.
 */

import { Hono } from "hono";
import { requireAuth } from "@/api/middleware/auth.ts";
import { NotFoundError } from "@/utils/errors.ts";
import { DOCS_PAGES, findDoc } from "@/services/docs/registry.ts";
import { searchDocs } from "@/services/docs/search.ts";

const docsRoutes = new Hono();

docsRoutes.use("*", requireAuth);

// TOC: page metadata only (no bodies — keeps the list payload small).
docsRoutes.get("/", (c) =>
  c.json({
    pages: DOCS_PAGES.map(({ slug, title, group, summary }) => ({
      slug,
      title,
      group,
      summary,
    })),
  }));

// Semantic search across all pages.
docsRoutes.get("/search", async (c) => {
  const q = (c.req.query("q") ?? "").trim();
  if (!q) return c.json({ results: [] });
  const limit = Math.min(Math.max(parseInt(c.req.query("limit") ?? "8", 10) || 8, 1), 25);
  const results = await searchDocs(q, limit);
  return c.json({ results });
});

// One page with its rendered-markdown body.
docsRoutes.get("/:slug", (c) => {
  const page = findDoc(c.req.param("slug"));
  if (!page) throw new NotFoundError("Doc");
  return c.json({ page });
});

export { docsRoutes };
