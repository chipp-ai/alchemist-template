/**
 * Docs search — semantic, with a keyword fallback.
 *
 * Embeds the query via the LLM proxy and cosine-ranks it against the
 * cached chunk embeddings in `doc_search_index` (computed in-process —
 * the corpus is tiny, so a full scan beats a pgvector dependency, same
 * call the platform agent search makes). When embeddings are unavailable
 * (proxy unconfigured / cold index), falls back to a keyword overlap
 * score so search still returns useful results in local dev.
 */

import { db, isDatabaseConfigured } from "@/db/client.ts";
import { findDoc } from "./registry.ts";
import { embedOne } from "@/services/llm/embeddings.ts";

export interface DocSearchResult {
  slug: string;
  title: string;
  heading: string;
  snippet: string;
  score: number;
  /** "semantic" (cosine) or "keyword" (fallback). */
  mode: "semantic" | "keyword";
}

const SNIPPET_CHARS = 240;

export function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0, na = 0, nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/** Cheap term-overlap score for the no-embeddings fallback. */
export function keywordScore(query: string, content: string): number {
  const terms = query.toLowerCase().split(/\W+/).filter((t) => t.length > 2);
  if (terms.length === 0) return 0;
  const hay = content.toLowerCase();
  let hits = 0;
  for (const t of terms) if (hay.includes(t)) hits++;
  return hits / terms.length;
}

function snippet(content: string): string {
  // Drop a leading markdown heading line so the snippet shows body text.
  const body = content.replace(/^#{1,6}\s+.*\n+/, "").trim() || content.trim();
  return body.length > SNIPPET_CHARS ? `${body.slice(0, SNIPPET_CHARS)}…` : body;
}

/**
 * Search the docs. Returns up to `limit` ranked results. Never throws —
 * returns [] on any error or when the index is empty.
 */
export async function searchDocs(
  query: string,
  limit = 8,
): Promise<DocSearchResult[]> {
  const q = query.trim();
  if (!q || !isDatabaseConfigured()) return [];

  let rows: { slug: string; heading: string; content: string; embedding: string }[];
  try {
    rows = await db
      .selectFrom("doc_search_index")
      .select(["slug", "heading", "content", "embedding"])
      .execute();
  } catch {
    return [];
  }
  if (rows.length === 0) return [];

  const queryVec = await embedOne(q);

  let scored: { row: typeof rows[number]; score: number; mode: "semantic" | "keyword" }[];
  if (queryVec) {
    scored = rows.map((row) => {
      let vec: number[];
      try {
        vec = JSON.parse(row.embedding) as number[];
      } catch {
        vec = [];
      }
      return { row, score: cosineSimilarity(queryVec, vec), mode: "semantic" as const };
    });
  } else {
    scored = rows
      .map((row) => ({
        row,
        score: keywordScore(q, `${row.heading}\n${row.content}`),
        mode: "keyword" as const,
      }))
      .filter((s) => s.score > 0);
  }

  scored.sort((a, b) => b.score - a.score);

  return scored.slice(0, limit).map(({ row, score, mode }) => ({
    slug: row.slug,
    title: findDoc(row.slug)?.title ?? row.slug,
    heading: row.heading,
    snippet: snippet(row.content),
    score: Math.round(score * 1000) / 1000,
    mode,
  }));
}
