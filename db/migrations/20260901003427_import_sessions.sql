-- Import sessions -- one row per run of the spreadsheet import wizard.
--
-- The wizard is four steps (upload, map, preview, commit) and a person
-- can leave between any two of them. The session is where that progress
-- lives. It is NOT a cache: a step's state has to survive the next
-- deploy and be readable by whichever pod serves the following request,
-- so it is a table rather than anything in memory.
--
-- See src/services/import/import.service.ts.
--
-- WHAT IS NOT HERE: the file's rows. The uploaded file already lives in
-- storage behind uploaded_files, so each step re-reads and re-parses it
-- rather than carrying a copy of the grid in a JSONB column. A 20k-row
-- spreadsheet is a few megabytes of text; parsing it again costs
-- milliseconds and keeps this table small enough to read at a glance.
--
-- uploaded_file_id is ON DELETE SET NULL, not CASCADE. Somebody deleting
-- the source file must not erase the record of what was imported from
-- it: the result column is the only account of what landed.
--
-- status
--   parsed     the file is readable and a mapping has been proposed
--   mapped     a person confirmed the mapping
--   committed  the upsert ran; `result` holds the counts and failures
--   failed     the commit was rolled back; `result` says why
--
-- Both JSONB columns carry the CHECK the 2026-07-28 audit added to every
-- existing one: a double-encoded write (JSON.stringify into a jsonb
-- parameter) lands as a jsonb string scalar and is invisible until a
-- structural operator detonates it. Failing at write time is the point.

CREATE TABLE import_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,

  -- The registered ImportDefinition this run targets. TEXT, not an FK:
  -- definitions live in code, not in a table.
  definition_name TEXT NOT NULL,

  uploaded_file_id UUID REFERENCES uploaded_files(id) ON DELETE SET NULL,
  filename TEXT NOT NULL,

  status TEXT NOT NULL DEFAULT 'parsed'
    CHECK (status IN ('parsed', 'mapped', 'committed', 'failed')),

  -- Which sheet, and which row in it held the headings. Stored so a
  -- later step re-parses the file exactly the way the first step did.
  sheet_name TEXT,
  header_row_index INTEGER NOT NULL DEFAULT 0,

  -- Column labels as parsed, in order. The mapping is keyed by index
  -- into this array.
  columns JSONB NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(columns) <> 'string'),
  -- [{ columnIndex, fieldKey, custom }]. The proposal until somebody
  -- confirms it, their choices afterwards.
  mapping JSONB NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(mapping) <> 'string'),

  row_count INTEGER NOT NULL DEFAULT 0,

  -- The commit outcome: counts plus every row that did not land, named.
  result JSONB
    CHECK (result IS NULL OR jsonb_typeof(result) <> 'string'),
  committed_at TIMESTAMPTZ,

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- "My recent imports", newest first. The only listing this table has.
CREATE INDEX idx_import_sessions_org_created
  ON import_sessions (organization_id, created_at DESC);

-- The per-definition history a wizard shows above its own upload step.
CREATE INDEX idx_import_sessions_org_definition
  ON import_sessions (organization_id, definition_name, created_at DESC);

-- Same updated_at trigger every other table in this schema uses
-- (defined in 001_initial_schema.sql).
CREATE TRIGGER trg_import_sessions_updated_at
  BEFORE UPDATE ON import_sessions
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
