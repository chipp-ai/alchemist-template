-- The people roster behind the WORKED EXAMPLE import definition.
--
-- src/services/import/examples/people.ts registers an ImportDefinition
-- against this table. It is the copy-from reference: an app adding its
-- own import copies that file, points it at its own table, and deletes
-- this one along with the definition.
--
-- Deliberately plain. Four columns, one org scope, one uniqueness rule.
-- Anything cleverer here would read as part of the framework rather than
-- as the customer's own table, which is exactly the confusion the
-- example exists to prevent.
--
-- The unique index on (organization_id, lower(email)) is the DATABASE
-- half of the identity contract. The definition's `matchBy` finds the
-- existing row and turns the import into an UPDATE; this index is what
-- stops a second copy from landing if that ever fails. Case-insensitive
-- because 'Ana@work.com' and 'ana@work.com' are one person, and the
-- import normalizes email to lowercase before it writes.

CREATE TABLE import_demo_people (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,

  first_name TEXT NOT NULL,
  last_name TEXT,
  email TEXT NOT NULL,
  start_date DATE,
  team TEXT,

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX idx_import_demo_people_org_email
  ON import_demo_people (organization_id, lower(email));

-- The roster listing: one org, alphabetical.
CREATE INDEX idx_import_demo_people_org_name
  ON import_demo_people (organization_id, last_name, first_name);

-- Same updated_at trigger every other table in this schema uses
-- (defined in 001_initial_schema.sql).
CREATE TRIGGER trg_import_demo_people_updated_at
  BEFORE UPDATE ON import_demo_people
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
