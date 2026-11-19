-- Where a site form lead came from (landing campaigns, 2026-11-19).
--
-- `attribution` holds the UTM values and ad click ids of the page the
-- visitor sent the form from (read from the Referer by
-- POST /api/site-forms/:name), plus `landingCampaign` and
-- `landingCampaignName` when the page was a campaign variant
-- (landing/src/lib/campaigns.ts). Keys are camelCase (utmSource,
-- utmCampaign, gclid), because Kysely's CamelCasePlugin renames nested
-- JSONB keys on read. NULL when the page URL had none.
--
-- Additive only.

ALTER TABLE site_form_submissions
  ADD COLUMN IF NOT EXISTS attribution JSONB
  CHECK (attribution IS NULL OR jsonb_typeof(attribution) = 'object');
