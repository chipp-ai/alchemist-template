# Common pitfalls

## Common Pitfalls

This section grows as mistakes are discovered. Check it before writing code.

- **`zValidator` must always pass `validationHook`** -- raw ZodError objects are unreadable to clients
- **Zod `.trim()` before `.min(1)` for name fields** -- whitespace-only strings pass `.min(1)`
- **JSONB columns return as strings** -- always `JSON.parse()` before using
- **Never `JSON.stringify()` for Kysely JSONB** -- pass objects directly, stringify double-encodes
- **`countAll()` returns string** -- wrap with `Number()`
- **`whereIn()` with empty array crashes** -- guard with early return
- **CamelCase in SELECT/INSERT, snake_case in WHERE/ORDER** -- the CamelCasePlugin only transforms result columns
- **SPA error redirects use `replace()`, not `push()`** -- prevents back-button loops
- **A tenant switch (org / workspace / account) or logout must call `runContextSwitch()` AFTER the server confirms, and every `<Router>` stays inside the `routerKey` `{#key}` in `App.svelte`** -- pages fetch in `onMount` and rely on the remount; a per-page org-id watch is the wrong fix (see "Tenant and route context")
- **Hard reload after frontend changes** -- HMR is disabled
- **Test isolation requires `createIsolatedUser()`** -- shared users cause FK violations in parallel tests
- **Deno 2: `Deno.run` removed** -- use `new Deno.Command(...)` (Deno 1 idiom is the default in training data)
- **Hono 4: custom context via `Hono<{ Variables: ... }>` generic** -- not v3 global `Hono.Variables` augmentation
- **Arctic 2: tokens are objects with method calls** -- `tokens.accessToken()`, not `tokens.accessToken`
- **date-fns 3: no default export** -- `import { format } from "date-fns"`, not `import dateFns from "date-fns"`
- **Stripe 17: pin `apiVersion` on the client** -- SDK major and API version must agree
- **Svelte 5 runes only** -- `$props()`, `$state()`, `$derived`, `$effect`, `{@render children()}`. NEVER `export let` (compile error)
- **Never call `sendEmail` from a route or job** -- compose with `renderEmailKind`, deliver with `enqueueEmail` (outbox); synchronous sends are for auth-critical kinds only
- **Every enqueued email from a job gets `ctx.idempotencyKey(...)`** -- a stale-lock re-run must not double-send
- **A newsletter is a campaign, never a loop over `enqueueEmail`** -- `src/services/mailing/` owns the sender check, consent, hygiene, warm-up and unsubscribe (see "Newsletters and bulk email")
- **Typed Kysely `where`/`orderBy` take camelCase column names** (`"organizationId"`); snake_case is for raw `sql` templates only
- **The look lives in `web/src/design/design.json`** -- never hardcode a `font-family`, a hex colour or a font `<link>`; never edit `app.css` token values to restyle
- **New UI component = add it to `/#/design`** in the same change, using global classes from `app.css`
- **A new feature without agent tools is unfinished** -- register its tools in `src/services/agent-tools/`, scoped by `ctx.user.organizationId` (see "Embedded agent tools")
