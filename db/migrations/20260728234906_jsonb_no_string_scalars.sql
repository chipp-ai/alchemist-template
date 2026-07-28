-- JSONB double-encoding guard (inherited from the chipp-deno 2026-07-28
-- audit: 62 columns / ~1.9M rows silently corrupted platform-side by this
-- exact defect).
--
-- postgres.js serializes parameters per the SERVER-declared type: a
-- jsonb-bound parameter is JSON-serialized by the CLIENT, so passing a
-- pre-stringified value (JSON.stringify(x)) double-encodes it into a jsonb
-- STRING SCALAR, and an explicit ::jsonb cast does NOT parse it back.
-- Tolerant readers hide the corruption until a SQL-level structural op
-- (|| append, @> containment, -> extraction) detonates it.
--
-- This migration adds CHECK (jsonb_typeof(col) <> 'string') NOT VALID to
-- every EXISTING jsonb column in this app's schema so a double-encoding
-- write fails loudly at write time. NULLs pass (jsonb_typeof(NULL) IS NULL).
--
-- CONVENTION (see CLAUDE.md): every NEW jsonb column must ship the same
-- CHECK in the migration that creates it. If a column legitimately stores
-- bare JSON string scalars, skip the CHECK with a comment saying why.
DO $$
DECLARE
  r record;
  cname text;
BEGIN
  FOR r IN
    SELECT c.table_name AS t, c.column_name AS col
    FROM information_schema.columns c
    JOIN pg_class pc ON pc.relname = c.table_name
    JOIN pg_namespace n ON n.oid = pc.relnamespace AND n.nspname = c.table_schema
    WHERE c.data_type = 'jsonb'
      AND pc.relkind = 'r'
      AND c.table_schema = current_schema()
  LOOP
    cname := 'jnss_' || left(r.t, 35) || '_' || left(md5(r.t || '.' || r.col), 12);
    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint con
      JOIN pg_class pc2 ON pc2.oid = con.conrelid
      JOIN pg_namespace n2 ON n2.oid = pc2.relnamespace
      WHERE con.conname = cname AND n2.nspname = current_schema() AND pc2.relname = r.t
    ) THEN
      EXECUTE format(
        'ALTER TABLE %I ADD CONSTRAINT %I CHECK (jsonb_typeof(%I) <> ''string'') NOT VALID',
        r.t, cname, r.col
      );
    END IF;
  END LOOP;
END $$;
