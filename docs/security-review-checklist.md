# Security Review Checklist

The playbook for the **security** pass of the agent pipeline (runs after
review, before docs). Audit the committed diff for the vulnerability classes
below, then **fix what you find inline and push** (you are the last gate before
the change ships). Ordered by damage potential.

## How to run this pass

- **Scope to the diff.** Audit what THIS ticket changed (`git diff` since the
  base), not the whole repo.
- **Fan out** `codebase-explorer` (trace every caller / sibling path of the
  changed code, and the auth boundary it sits behind) and `docs-explorer`
  (search this checklist + any `docs/` pitfalls for the relevant class).
- **Fix inline + commit** (`fix(security): …`). Flag-without-fixing only when
  the fix is genuinely out of scope, and say so.
- Write `.scratch/findings-security.md` (every issue: class, file:line,
  severity, what you changed) so the docs pass can close the doc-gap.

---

## 1. Cross-tenant / cross-user data leakage (HIGHEST PRIORITY)

If this app serves multiple users/orgs, a user of A must NEVER read, write, or
learn the existence of B's data.

- **Signal:** a query, cache key, or storage path keyed by an id from the
  **request** (`userId`, `orgId`, `workspaceId`) without a server-side ownership
  check; a listing endpoint not scoped to the caller; resolving access against a
  client-supplied key instead of the authoritative owner (IDOR).
- **Fix:** resolve the authoritative scope **server-side** from the session /
  owning row and authorize against that. Every multi-tenant listing query
  carries an explicit owner predicate.

## 2. Missing authorization on resource routes

- **Signal:** a route reads/writes/deletes a resource by id with no ownership
  check; `// TODO: add auth` comments; bulk operations with no owner predicate.
- **Fix:** add the access check before the action. Reuse the auth middleware's
  already-resolved session/user, don't re-derive trust from a request param.
  Validate route params (UUIDs) before the DB call.

## 3. Open redirect

- **Signal:** a user-controlled value (`redirect`, `returnUrl`, `next`, OAuth
  `state`) reaching a redirect without validation — usually OAuth callbacks
  (Arctic) and post-login flows.
- **Fix:** validate the target against an allowlist of known origins; fall back
  to a safe internal path otherwise.

## 4. SSRF in outbound fetch

- **Signal:** `fetch(url)` where `url` comes from user input, config, a webhook,
  or LLM/tool output.
- **Fix:** enforce HTTPS, block private/loopback hostnames, DNS-resolve to catch
  private IPs before fetching; set `redirect: "error"` + `AbortSignal.timeout()`.

## 5. Injection (SQL / command / XSS)

- **SQL:** never interpolate user input into raw SQL — use **Kysely** query
  builder / parameterized bindings (this template uses Kysely, NOT an ORM that
  hides the query). Escape `%`/`_` in ILIKE. Note Kysely's CamelCasePlugin maps
  camelCase ↔ snake_case even in raw `sql<…>` templates.
- **Command:** array-argument exec, never string-interpolated shell.
- **XSS:** `encodeURIComponent` in URL contexts; sanitize any user HTML/SVG;
  Svelte auto-escapes `{expr}` — be careful with `{@html ...}`.

## 6. Sensitive data exposure

- **In responses:** don't spread a whole DB row to the client (leaks secrets /
  other-user PII). Allowlist returned fields.
- **In logs:** never log API keys, tokens, secrets, auth headers, or full
  request bodies.

## 7. Path traversal in file handlers

- **Signal:** user-supplied filename/path in fs / object-storage paths or
  `path.join` without stripping `../`.
- **Fix:** `basename()` + reject `..` + resolve and verify the result stays
  under the intended base dir; validate MIME from content, not the client type.

## 8. Webhook signature verification

- **Signal:** an inbound webhook (e.g. Stripe) processed without verifying its
  signature, or a secret compared with `===`.
- **Fix:** verify with a **timing-safe** comparison; for Stripe use the SDK's
  signature verification. Fail closed when the secret is configured.

## 9. Authentication weaknesses

- **Signal:** gating on a spoofable signal instead of a role/capability;
  unauthenticated debug endpoints; auth endpoints without rate-limiting or
  account-enumeration protection.
- **Fix:** role/permission checks; rate-limit + lockout on auth endpoints;
  prevent account enumeration; use the session middleware consistently.

## 10. Secrets, CORS, encryption

- No hardcoded credentials in source — use env vars.
- No wildcard CORS on credentialed endpoints.
- Use the platform's `encrypt()`/`decrypt()` helpers; don't hand-roll crypto.

---

## What is NOT this pass's job

- Performance, style, test coverage — that's the review pass.
- Dependency CVEs — handled by dependency tooling.
- Re-litigating intentional, documented exceptions.
