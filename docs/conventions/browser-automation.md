# Browser automation

## Browser automation / portal scraping: a platform capability (do NOT build it here)

When a ticket asks to log into a third-party web portal, scrape data from
it, submit data to it, or schedule a recurring pull (or names
playwright/puppeteer/selenium), **never add browser automation to this
repo**. No playwright, no puppeteer, no chromium download, no cookie-jar
login clients. The Alchemist platform operates a hardened browser lane:
headless Chromium in a sandbox, postback-safe interaction primitives,
encrypted credential + session storage (secret values never enter code or
LLM context), human SSO/MFA handoff for portals behind SSO, and a
scheduled runner for recurring flows with failure auto-pause. A repo-local
rebuild of any of that is a security regression and will be rejected in
review.

What THIS repo contributes:

- **Destination tables** for the scraped data, with provenance columns
  (`source`, `scraped_at`) and an idempotent natural UNIQUE key (flows
  re-run and overlap with backfills; a landing table without an upsert
  key accumulates duplicates).
- Nothing else. Writes land through the platform's gated data-operation
  lane, never via an in-repo scraper or an open DB credential.

How the capability is engaged: portal credentials are stored
platform-side under NAMES (e.g. `ACME_PORTAL_USER` / `ACME_PORTAL_PASS`);
the project's conversational agent authors the scrape flow interactively
against the live portal and promotes the working session to a saved,
scheduled flow. If the portal turns out to have a real HTTP API, skip
this lane and write a normal API client service instead. Full contract:
the platform recipe `browser-scrape-flows`.
