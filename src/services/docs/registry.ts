/**
 * In-app docs registry — the source of truth for the `/docs` section.
 *
 * Each page's `body` is a LIVE READ of a markdown file under `docs/**`
 * (NOT a hand-maintained copy), loaded synchronously at module load so a
 * missing file fails loudly at boot instead of silently serving an empty
 * page. Keeping the body a live read of `docs/**` means the same markdown
 * powers this section, the search index, AND your project's AI agent —
 * one source of truth.
 *
 * To add a page: drop a `.md` file under `docs/in-app/` (or anywhere in
 * `docs/`) and add an entry below. The search indexer
 * (src/services/docs/reindex.ts) picks it up on the next boot.
 */

export interface DocPage {
  /** URL-safe id; also the search-result link target (`#/docs/<slug>`). */
  slug: string;
  /** Page title shown in the TOC and as the article heading. */
  title: string;
  /** TOC group header. Pages are grouped by this in registry order. */
  group: string;
  /** One-line description shown under the title in the TOC. */
  summary: string;
  /** Markdown body — a live read of a `docs/**` file. */
  body: string;
}

/**
 * Read a markdown file from the repo root. This module lives at
 * `src/services/docs/`, so `../../../` reaches the repo root. Synchronous
 * so a missing file throws at module-load (fail loud, not silent).
 */
function loadDoc(relPath: string): string {
  return Deno.readTextFileSync(new URL(`../../../${relPath}`, import.meta.url));
}

export const DOCS_PAGES: DocPage[] = [
  {
    slug: "welcome",
    title: "Welcome to your in-app docs",
    group: "Getting started",
    summary: "What the docs section is and how it works.",
    body: loadDoc("docs/in-app/welcome.md"),
  },
  {
    slug: "searching-docs",
    title: "Searching the docs",
    group: "Getting started",
    summary: "Semantic search, what gets indexed, and auto-reindexing.",
    body: loadDoc("docs/in-app/searching-docs.md"),
  },
];

/** Find a single page by slug, or `undefined` if no such page exists. */
export function findDoc(slug: string): DocPage | undefined {
  return DOCS_PAGES.find((p) => p.slug === slug);
}
