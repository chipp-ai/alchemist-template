---
name: security
description: Security rules for this stack - tenant scoping, route authorization, open redirects, SSRF, injection with Kysely and Svelte, secrets and codes out of logs, file paths, webhook signatures, auth rate limits, CORS, user content (links, SVG, CSV, uploads, decompression), and member text in LLM prompts. Load when writing any route, service or auth code.
paths:
  - "src/api/**"
  - "src/auth/**"
  - "src/services/**"
  - "app.ts"
---

# Security rules for this stack

Check your own diff against these before you report. Ordered by damage
potential. Each one is a class that shipped on a customer project built from
this template.

## 1. Cross-tenant and cross-user data

A user of org A must never read, write, or learn the existence of org B's data.

- A query, cache key or storage path keyed by an id from the request
  (`userId`, `orgId`, a row id) has the caller's `organizationId` (from the
  session, never from the body) in its WHERE clause. Another org's id is a 404.
- Every listing query carries an explicit owner predicate.

## 2. Authorization on every route

- A route that reads, writes or deletes a resource by id checks access before
  the action, with the session user `requireAuth` resolved. Validate UUID
  params before the DB call.
- `requireCapability("app.read")` admits viewers and portal users. See the
  `auth` rule, "REST routes and portal users".

## 3. Open redirect

- A user-controlled `redirect`, `returnUrl`, `next` or OAuth `state` reaches a
  redirect only after a check against the app's own origins
  (`requestWebOrigin()` / `appPath()`), else a safe internal path.

## 4. SSRF in outbound fetch

- `fetch(url)` with a URL from user input, config, a webhook or model output:
  https only, no private, loopback or link-local host, `redirect: "error"`,
  `AbortSignal.timeout()`. The URL check in `src/lib/event-webhooks.ts` does
  the host part (it does not resolve DNS, and says why); reuse it.

## 5. Injection

- **SQL:** Kysely builder or `sql` template bindings only, never string
  interpolation. Escape `%` and `_` in ILIKE.
- **Command:** `new Deno.Command(cmd, { args: [...] })`, never a shell string.
- **XSS:** Svelte escapes `{expr}`; never put user text in `{@html}`. Server
  HTML uses `escapeHtml` from `src/lib/safe-html.ts`. `encodeURIComponent` in
  URL contexts.

## 6. Secrets, codes and PII stay out of logs and responses

- Never log a token, API key, auth header, sign-in code, full request body or
  provider error that echoes one. The email transport logs a message's `kind`,
  never its subject or body; keep secrets out of subjects too.
- Never spread a DB row into a response; list the fields.
- Clear personal data from `localStorage` on sign-out.

## 7. File paths and uploads

- A user-supplied filename never builds a storage or fs path: keys come from
  `scopedKey()` and a uuid (`files` rule). Validate type from content.
- Serve uploads with `Content-Disposition: attachment` (`downloadFilename`),
  never inline: HTML or SVG uploaded as `.txt` runs on the app's origin.
- Cap size and decompressed size before parsing on the server. A `.docx` or
  `.xlsx` is a zip: check entry count and total uncompressed bytes first. A
  size check only in the browser is not a check.
- No regex with nested or adjacent unbounded quantifiers over user text
  (quadratic backtracking blocks the one server thread). Bound the input
  length first.

## 8. Webhook signatures

- Verify every inbound webhook signature with a timing-safe compare (Stripe:
  the SDK). Fail closed when the secret is set. Return 5xx only for a failure
  a retry can fix.

## 9. Auth endpoints

- Every route that mints or checks a code, a link or a session has per-identity
  and per-IP limits (`OTP_LIMITS` in `src/api/routes/auth/index.ts`, the IP
  from `src/lib/client-ip.ts`), and a cap that must hold is one atomic SQL
  statement, never the fail-open Redis limiter alone. Full contract: `docs/conventions/auth.md`,
  "Sign-in codes (OTP) contract".
- Messages never tell a caller whether an account exists for an address.

## 10. Secrets, CORS, encryption

- No credentials in source: env vars through `getEnv()`.
- CORS is credentialed, so it answers only `isAllowedCorsOrigin()` in
  `src/services/app-links.ts`. Never reflect the request's Origin; to allow a
  new browser origin, add it there.
- Never hand-roll crypto. Use Web Crypto (`crypto.subtle`) and compare secrets
  in constant time.

## 11. User content is data

- A link a user saves goes through `sanitizeHref` (`src/lib/safe-html.ts`) on
  write and again on render. It keeps http, https, mailto, tel and same-site
  paths, and refuses `javascript:`, `data:` and `vbscript:`.
- SVG and HTML from users are sanitized by an allowlist, never a blocklist.
- A CSV or XLSX export prefixes a cell that starts with `=`, `+`, `-`, `@`, tab
  or carriage return with `'`, so a spreadsheet does not run it as a formula.

## 12. Member text in LLM prompts

- Text a member or visitor wrote goes into an `llmMessages` / `llmStructured`
  prompt only inside clear delimiters (for example `<member_text>...</member_text>`),
  with an instruction to treat it as data, never in the system prompt bare.
- Never gate access or money on a flag the model returns. An empty model
  answer is a valid answer, not a trigger to retry until it invents one.
