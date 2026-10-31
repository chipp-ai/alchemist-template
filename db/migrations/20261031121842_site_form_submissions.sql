-- Site form submissions: what visitors send through the landing site's
-- form sections (landing/src/components/sections/Form.astro), for example a
-- contact form rebuilt from a migrated site.
--
-- One row per submission. `form_name` is the form's name in the landing
-- content (landing/src/content/pages/*.json); `data` holds the submitted
-- fields as a JSON object, keyed by field name, so any form fits without a
-- new table. Rows are written only by POST /api/site-forms/:name
-- (src/api/routes/site-forms/index.ts), which also queues the owner email in
-- the same transaction.
--
-- Additive only.

CREATE TABLE IF NOT EXISTS site_form_submissions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  form_name TEXT NOT NULL CHECK (char_length(form_name) BETWEEN 1 AND 64),
  page_path TEXT NOT NULL CHECK (char_length(page_path) <= 512),
  data JSONB NOT NULL CHECK (jsonb_typeof(data) = 'object'),
  user_agent TEXT CHECK (user_agent IS NULL OR char_length(user_agent) <= 500),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS site_form_submissions_form_created
  ON site_form_submissions (form_name, created_at DESC);
