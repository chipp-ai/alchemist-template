# Dev affordances

## Dev affordances — DO NOT reverse-engineer auth from scratch

When NODE_ENV is anything other than `production` (which is the case in
the local dev stack AND inside the agent's E2B sandbox), the platform
mounts a small set of **dev-only routes** at `/api/dev/*` so you can
verify auth-gated flows without driving the OTP send + email + verify
cycle. SMTP is not configured in the sandbox, so the OTP email goes to
console — agents that try to verify the signup flow without these
routes will spend tokens screen-scraping the log. Don't.

### Available endpoints

```
GET  /api/dev/info     # Capability advertisement (safe to call first to
                       # confirm the routes are live).
POST /api/dev/login    # Body: { email, name? }
                       # Looks up or creates user + org, sets the same
                       # session_id cookie /verify-otp would set.
                       # Returns { user, organization, session_cookie }.
POST /api/dev/seed     # Body: { users?: [{email, name?}], raw?: [{table, rows}] }
                       # Bulk-create users with their own orgs, AND/OR
                       # ad-hoc inserts into any app./billing./jobs.
                       # table. Both modes run in one transaction.
POST /api/dev/reset    # Body: { tables?: [...] } (default = all
                       # app/billing/jobs tables). TRUNCATE CASCADE.
                       # Use BEFORE seeding for a known starting point.
POST /api/dev/jobs/tick # Body: { now?: ISO } — run one job-runner tick NOW
                       # (scheduled jobs, campaign releases, then outbox delivery). `now` time-
                       # travels: verify Monday's digest without waiting.
GET  /api/dev/jobs     # Registered job kinds + every scheduled_jobs row.
GET  /api/dev/outbox   # Recent email_outbox rows (?status=&limit=). THE way
                       # to verify "did the email go out" — read the row,
                       # don't scrape the server log.
GET  /api/dev/design   # design.json + WCAG warnings + presets + font catalog
                       # (?match=<words> ranks presets by vibe)
PUT  /api/dev/design   # validate + write design.json (body = DesignConfig)
POST /api/dev/design/preset  # { preset } — apply a preset verbatim
```

### Recipe — verify a route that requires auth

```bash
# Inside the sandbox after ensure_local_dev_server succeeded:

# 1. Reset to a clean DB (optional but recommended).
curl -sS -X POST -H 'Content-Type: application/json' \
  -d '{}' http://localhost:8000/api/dev/reset

# 2. Instant-login as the user you want to be.
curl -sS -X POST -H 'Content-Type: application/json' \
  -d '{"email":"agent@dev.local"}' \
  http://localhost:8000/api/dev/login \
  -c /tmp/jar.txt

# 3. Hit the auth-gated route with the cookie jar.
curl -sS -b /tmp/jar.txt http://localhost:8000/api/auth/me
# → { user: { id, email, name }, organization: {...} }
```

### Recipe — verify the same flow in the headless browser

The dev login sets a real `session_id` cookie that's identical to
what `/verify-otp` would set, so once you've POSTed to
`/api/dev/login` from the page (e.g. via `browser_execute_js`), the SPA
behaves as if the user is logged in.

```ts
// Browser ALWAYS targets the Vite port (__VITE_PORT__), never the API
// port. Vite serves the SPA shell + proxies /api → :__API_PORT__, so
// the relative `/api/dev/login` fetch below reaches the API correctly.
browser_navigate({ url: "http://localhost:__VITE_PORT__/" })

// Bypass OTP — set the session via dev-login from the page itself.
browser_execute_js({
  code: `(async () => {
    const r = await fetch('/api/dev/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ email: 'agent@dev.local' }),
    });
    return r.status;
  })()`
})

browser_navigate({ url: "http://localhost:__VITE_PORT__/dashboard" })  // now authed
browser_take_screenshot()  // capture the proof
```

### Recipe — populate mock domain data for visual verification

When the operator asks to "populate mock data", "seed sample
recipes", "fill in placeholder images", or "make the empty state
look real" — DO NOT edit the rendering component to invent a
placeholder. The page renders FROM the DB; changing only the
component leaves you with the same empty rows.

**Do NOT reset reflexively.** Operator-seeded rows live in the
same tables; `/api/dev/reset` wipes everything. The correct flow
inspects first and only resets when existing data is structurally
unfixable (NULL on a field the UI requires, AND no way to fix it
without re-seeding):

```bash
# 1. SEE what's already there.
curl -sS http://localhost:8000/api/<resource-list-endpoint>
# If rows exist with the field the UI needs, do NOT seed — the
# rendering side is what's wrong (auth wall, route mismatch,
# component bug). Diagnose that instead.

# 2. Get the organization_id you'd seed INTO if rows are missing
# or have NULL on the field the UI needs.
curl -sS -X POST -H 'Content-Type: application/json' \
  -d '{"email":"agent@dev.local"}' \
  http://localhost:8000/api/dev/login | jq -r '.organization.id'

# 3. Reset ONLY when existing rows are structurally wrong AND you
# can't UPDATE in place (/api/dev/seed is INSERT-only by design).
# Narrate the destruction out loud BEFORE running so the operator
# can stop you: "Clearing N existing rows so I can re-seed with
# photo URLs filled in." NEVER skip this announcement.
curl -sS -X POST -H 'Content-Type: application/json' \
  -d '{"tables":["recipes"]}' \
  http://localhost:8000/api/dev/reset

# 4. Insert with EVERY column the UI reads, including image URLs.
curl -sS -X POST -H 'Content-Type: application/json' \
  -d '{"raw":[{"table":"recipes","rows":[
    {"organization_id":"<UUID>","title":"...","slug":"...",
     "description":"...","photo_url":"https://images.unsplash.com/...",
     "photo_width":1200,"photo_height":1600,
     "servings":4,"prep_minutes":30,"cook_minutes":12}
  ]}]}' \
  http://localhost:8000/api/dev/seed
```

**Image URL conventions** (use real CDN URLs, not `/placeholder.png`):

- Unsplash: `https://images.unsplash.com/photo-<ID>?w=1200&q=80&auto=format&fit=crop` — direct asset URLs, no rate limit at small scale, food/people/landscape topics search-friendly via `unsplash.com/s/photos/<topic>`.
- Picsum: `https://picsum.photos/seed/<slug>/1200/900` — deterministic-by-seed, good for "any image will do" cases.
- Avatars: `https://i.pravatar.cc/300?u=<email>` — deterministic by user email.

**There is NO PATCH endpoint** — `/api/dev/seed` only does INSERT and `/api/dev/reset` only does TRUNCATE. To "update" existing rows, reset the table first then re-insert with the new column values. This is intentional: the dev surface stays small, and the agent's mental model is "what should the DB look like" rather than "what's the column-level diff".

**Don't invent placeholders in components when the directive says "populate the data".** The user said "populate" because they want the DB rows to have real-looking values; a `<img src={photo_url ?? '/missing.svg'} />` fallback is not the same and feels broken if every row hits the fallback.

### Production safety

The whole dev router is wrapped in a guard middleware that throws
`NotFoundError` when `NODE_ENV === "production"`. The deployed
customer pod always has `NODE_ENV=production` (set by the rollout
controller) so the routes return 404 the same as if they had never
been registered. Don't remove this guard — the routes bypass auth.
