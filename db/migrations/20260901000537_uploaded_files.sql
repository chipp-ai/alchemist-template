-- Uploaded files -- the record behind every end-user upload.
--
-- Before this table, an upload was a key in a bucket and nothing else:
-- no idea who sent it, what record it belongs to, or whether anybody had
-- looked at it. Every customer app that needed those answers grew its own
-- attachments table, its own review flags, and its own admin screen. This
-- is that table, once, in the template.
--
-- See src/services/uploaded-file.service.ts.
--
-- storage_key
--
--   The RELATIVE key, without the tenant prefix, exactly as
--   storage.service.ts hands it back. Storing the relative key keeps the
--   row portable across a prefix change and across the R2 / local driver
--   split. Unique per org so a retried upload cannot mint a second row
--   pointing at the same bytes.
--
-- subject_type / subject_id
--
--   The record this file belongs to ('expense', 'claim', 'employee'),
--   nullable because plenty of uploads belong to nothing but the person
--   who sent them. TEXT rather than a typed FK, for the same reason
--   portal_access_tokens uses TEXT: the template does not know the
--   customer's tables. Adapt it to a real FK once you know yours.
--
-- status
--
--   pending_review -> approved | rejected, and a reviewer may correct a
--   decision afterwards. New rows start pending because that is the
--   fail-closed default: a file nobody has looked at is not yet fit to
--   be served to anybody but its uploader and an admin. An app that does
--   not want a queue approves on arrival and never opens the screen.
--
-- ON DELETE CASCADE from the org keeps the existing cleanup path (and
-- the test helper's org cascade) working unchanged. The uploader and the
-- reviewer are SET NULL: losing a person must not lose the file.

CREATE TABLE uploaded_files (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  uploaded_by UUID REFERENCES users(id) ON DELETE SET NULL,

  subject_type TEXT,
  subject_id TEXT,

  storage_key TEXT NOT NULL,
  filename TEXT NOT NULL,
  content_type TEXT NOT NULL,
  size_bytes BIGINT NOT NULL,

  status TEXT NOT NULL DEFAULT 'pending_review'
    CHECK (status IN ('pending_review', 'approved', 'rejected')),
  -- Why a reviewer rejected. Required on reject at the service layer; a
  -- rejection nobody can explain is a support ticket waiting to happen.
  review_reason TEXT,
  reviewed_by UUID REFERENCES users(id) ON DELETE SET NULL,
  reviewed_at TIMESTAMPTZ,

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- One row per stored object, per org. Makes a retried upload a conflict
-- rather than a duplicate.
CREATE UNIQUE INDEX idx_uploaded_files_org_key
  ON uploaded_files (organization_id, storage_key);

-- The review queue: pending files for one org, oldest first (a queue is
-- worked from the front). Partial, because the queue is the hot read and
-- approved rows would otherwise dominate the index.
CREATE INDEX idx_uploaded_files_review_queue
  ON uploaded_files (organization_id, created_at)
  WHERE status = 'pending_review';

-- Org-scoped listing and status filtering, newest first.
CREATE INDEX idx_uploaded_files_org_status
  ON uploaded_files (organization_id, status, created_at DESC);

-- "What is attached to this record" -- the join a customer app does.
CREATE INDEX idx_uploaded_files_subject
  ON uploaded_files (organization_id, subject_type, subject_id)
  WHERE subject_type IS NOT NULL;

-- "What did this person send" -- the uploader's own list.
CREATE INDEX idx_uploaded_files_uploader
  ON uploaded_files (uploaded_by, created_at DESC);

-- Same updated_at trigger every other table in this schema uses
-- (defined in 001_initial_schema.sql).
CREATE TRIGGER trg_uploaded_files_updated_at
  BEFORE UPDATE ON uploaded_files
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
