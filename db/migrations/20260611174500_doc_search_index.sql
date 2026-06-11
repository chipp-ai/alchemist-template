-- 20260611174500_doc_search_index.sql
-- In-app docs semantic search: the embedding index over the static docs
-- registry (src/services/docs/registry.ts).
--
-- App-global on purpose: in-app docs are product docs, identical for every
-- org, so this table is NOT organization-scoped. The reindexer
-- (src/services/docs/reindex.ts) upserts one row per heading-scoped chunk and
-- re-embeds only when content_hash changes. `embedding` is a JSON-encoded
-- float array stored as text; cosine similarity is computed in-process (the
-- corpus is tiny, so a full scan beats a pgvector dependency).
--
-- Unqualified table name: the customer DB role's search_path resolves it into
-- the customer's own schema (see 001_initial_schema.sql).

CREATE TABLE doc_search_index (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slug          TEXT NOT NULL,
  chunk_seq     INTEGER NOT NULL,
  heading       TEXT NOT NULL DEFAULT '',
  content       TEXT NOT NULL,
  content_hash  TEXT NOT NULL,
  embedding     TEXT NOT NULL,
  embed_model   TEXT NOT NULL,
  embedded_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- One row per (page, chunk); the reindexer upserts on this key.
CREATE UNIQUE INDEX doc_search_index_slug_chunk_idx
  ON doc_search_index (slug, chunk_seq);
