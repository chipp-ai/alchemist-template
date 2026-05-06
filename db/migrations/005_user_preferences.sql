-- 005_user_preferences.sql
-- Adds a free-form JSONB preferences column on users so customer apps
-- have a baseline place to stash per-user UI preferences (notification
-- toggles, timezone, locale, theme, …) without each one inventing a
-- new table.
--
-- Why JSONB rather than columns
--
-- Customers will add fields the template doesn't anticipate. A
-- preferences JSONB lets them write { emailDigest: false } the day
-- they want it, no migration required. The fields the template ITSELF
-- reads (none, currently — the SPA can render whatever's there) stay
-- forward-compatible.
--
-- Default '{}'::jsonb so reads on never-touched rows return an empty
-- object (NOT a JSON null), and the GET /auth/me/preferences endpoint
-- can always echo back a usable shape.

ALTER TABLE users
  ADD COLUMN preferences JSONB NOT NULL DEFAULT '{}'::jsonb;
