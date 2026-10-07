/**
 * Docs search reindexer.
 *
 * Runs once at app boot (hooked in main.ts, fire-and-forget + non-fatal).
 * Builds the chunk set from the docs registry, diffs each chunk's content
 * hash against the `doc_search_index` table, re-embeds ONLY changed/new
 * chunks via the LLM proxy, upserts them, and deletes rows for chunks that
 * no longer exist. Unchanged docs are skipped, so a boot with no doc
 * changes makes zero embedding calls.
 *
 * # Why boot-time is the complete trigger
 *
 * In-app docs are markdown files baked into the deployed image, so they
 * can ONLY change via a redeploy. Every deploy boots a fresh pod, which
 * runs this — so a boot-time reindex covers exactly the docs that changed
 * in that deploy, with zero manual steps and no cron/polling needed.
 *
 * # Multi-replica safety
 *
 * When the app runs multiple replicas, all boot at once. The upsert is
 * idempotent (ON CONFLICT) so concurrent runs can't corrupt the index,
 * but to avoid N replicas all paying to embed the same changed chunks we
 * take the job lock (`withJobLock`, src/lib/job-lock.ts, Redis). A replica
 * that can't get the lock skips. No connection is held while embedding, so
 * the per-statement `statement_timeout` never trips on the (slow) embedding
 * round-trip.
 *
 * The index is app-global (docs are product docs, identical for every
 * org), so there is no per-org scoping here. Non-fatal by contract.
 */

import { db, isDatabaseConfigured } from "@/db/client.ts";
import { log } from "@/lib/logger.ts";
import { withJobLock } from "@/lib/job-lock.ts";
import { LLM_CONFIG } from "@/config/llm.ts";
import { DOCS_PAGES } from "./registry.ts";
import { chunkMarkdown, contentHash } from "./chunk.ts";

const EMBED_BATCH = 96;
/** Job-lock name for the docs reindex (`withJobLock`, Redis, per project). */
const REINDEX_LOCK_NAME = "docs-reindex";
/** A crashed holder blocks peers for at most this long. Refreshed while running. */
const REINDEX_LOCK_TTL_S = 300;

export interface ReindexResult {
  embedded: number;
  deleted: number;
  skipped: number;
  reason?: string;
}

interface DesiredChunk {
  slug: string;
  chunkSeq: number;
  heading: string;
  content: string;
  hash: string;
}

/** Build the desired chunk set (with hashes) from the registry. No DB. */
async function buildDesired(): Promise<DesiredChunk[]> {
  const out: DesiredChunk[] = [];
  for (const page of DOCS_PAGES) {
    for (const ch of chunkMarkdown(page.body, page.title)) {
      out.push({
        slug: page.slug,
        chunkSeq: ch.seq,
        heading: ch.heading,
        content: ch.content,
        hash: await contentHash(ch.content),
      });
    }
  }
  return out;
}

/** A row "has an embedding" if its text is a non-empty JSON array. */
const hasEmbedding = (e?: string) => !!e && e !== "" && e !== "[]";

/**
 * Reindex the docs corpus. Safe to call on every boot. Holds the job lock
 * (`src/lib/job-lock.ts`) so only one replica works per rollout. Never throws.
 */
export async function reindexDocs(): Promise<ReindexResult> {
  if (!isDatabaseConfigured()) {
    return { embedded: 0, deleted: 0, skipped: 0, reason: "no-database" };
  }
  try {
    const outcome = await withJobLock(REINDEX_LOCK_NAME, REINDEX_LOCK_TTL_S, () => runReindex(db));
    if (!outcome.ran) return { embedded: 0, deleted: 0, skipped: 0, reason: "lock-held" };
    return outcome.value;
  } catch (err) {
    log.warn("docs reindex failed (non-fatal)", { source: "docs-reindex" }, err);
    return { embedded: 0, deleted: 0, skipped: 0, reason: "error" };
  }
}

/** The actual diff + embed + upsert + prune. */
async function runReindex(conn: typeof db): Promise<ReindexResult> {
  const desired = await buildDesired();

  const existing = await conn
    .selectFrom("doc_search_index")
    .select(["slug", "chunkSeq", "contentHash", "embedding"])
    .execute();
  const existingByKey = new Map(existing.map((r) => [`${r.slug}#${r.chunkSeq}`, r]));
  const desiredKeys = new Set(desired.map((d) => `${d.slug}#${d.chunkSeq}`));

  // Stale rows = indexed chunks no longer in the registry.
  const stale = existing.filter((r) => !desiredKeys.has(`${r.slug}#${r.chunkSeq}`));

  // Chunks needing a write = new, content-changed, OR content unchanged but
  // never embedded (so keyword-fallback rows upgrade to semantic once the
  // proxy is live).
  const toWrite = desired.filter((d) => {
    const ex = existingByKey.get(`${d.slug}#${d.chunkSeq}`);
    return !ex || ex.contentHash !== d.hash || !hasEmbedding(ex.embedding);
  });

  if (toWrite.length === 0 && stale.length === 0) {
    return { embedded: 0, deleted: 0, skipped: desired.length };
  }

  let deleted = 0;
  for (const s of stale) {
    await conn
      .deleteFrom("doc_search_index")
      .where("slug", "=", s.slug)
      .where("chunkSeq", "=", s.chunkSeq)
      .execute();
    deleted++;
  }

  // Try to embed pending chunks. If the proxy is unavailable, `vectors` is
  // null — we STILL upsert the content rows (embedding="") so keyword
  // fallback has data; the next boot with a live proxy re-embeds them.
  let embedded = 0;
  let persisted = 0;
  const { embedTexts } = await import("@/services/llm/embeddings.ts");
  for (let i = 0; i < toWrite.length; i += EMBED_BATCH) {
    const batch = toWrite.slice(i, i + EMBED_BATCH);
    const vectors = await embedTexts(batch.map((c) => c.content));
    if (!vectors) {
      log.info("docs reindex: embeddings unavailable — persisting content for keyword fallback", {
        source: "docs-reindex",
        configured: LLM_CONFIG.configured,
      });
    }
    for (let j = 0; j < batch.length; j++) {
      const c = batch[j];
      const vecText = vectors ? JSON.stringify(vectors[j]) : "";
      await conn
        .insertInto("doc_search_index")
        .values({
          slug: c.slug,
          chunkSeq: c.chunkSeq,
          heading: c.heading,
          content: c.content,
          contentHash: c.hash,
          embedding: vecText,
          embedModel: vectors ? LLM_CONFIG.embedModel : "",
        })
        .onConflict((oc) =>
          oc.columns(["slug", "chunkSeq"]).doUpdateSet({
            heading: c.heading,
            content: c.content,
            contentHash: c.hash,
            embedding: vecText,
            embedModel: vectors ? LLM_CONFIG.embedModel : "",
            embeddedAt: new Date(),
          })
        )
        .execute();
      persisted++;
      if (vectors) embedded++;
    }
  }

  log.info("docs reindex complete", {
    source: "docs-reindex",
    embedded,
    persisted,
    deleted,
    total: desired.length,
  });
  return { embedded, deleted, skipped: desired.length - persisted };
}
