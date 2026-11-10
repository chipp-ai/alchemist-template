# Path-scoped rule spokes (.claude/rules/)

## Convention spokes — `.claude/rules/`

This file is the **hub**: universal rules that apply everywhere. Deep,
area-specific conventions live in **spoke** files under `.claude/rules/`,
each scoped to a path glob via `paths:` frontmatter. A spoke loads only
when you work in its area, so the hub stays focused.

| Spoke | Auto-loads when you touch | Covers |
|---|---|---|
| `database.md` | `db/**`, `*.service.ts` | Postgres extensions, Kysely + CamelCasePlugin, migrations, query safety |
| `api-layer.md` | `src/api/**` | Hono routes, validation, response envelope, WebSockets |
| `auth.md` | `src/auth/**`, middleware, `roles.ts` | Role hierarchy, capabilities, invite flow, soft-disconnect |
| `services-jobs.md` | `src/services/**`, `src/jobs/**` | Service structure, logging contract, `AppError` classes |
| `events.md` | `src/lib/events.ts`, `src/jobs/event-consumer.ts`, `src/api/routes/events/**`, the events migration | Durable events: publish, consumer, inbox, outbound webhooks, retry and replay mechanics |
| `design.md` | `web/src/design/**`, `app.css`, `*.svelte` | design.json, presets, font catalog, token rules, the /#/design sheet |
| `ux.md` | `web/src/**/*.svelte`, `landing/src/**/*.astro` | The consumer UX bar: every state designed, one state one message, plain words, toasts for outcomes, one primary action, one left edge, done means seen |
| `frontend-state.md` | `web/src/App.svelte`, `web/src/routes.ts`, `web/src/recipe-routes.ts`, `web/src/routes/**`, `web/src/stores/**`, `query.svelte.ts`, `context-switch.svelte.ts` | Page lifetime and tenant context: the Router key, `runContextSwitch()`, store resets, the switcher checklist; public pages via `recipePublicRoutes` |
| `files.md` | `src/services/storage*.ts`, `uploaded-file.service.ts`, `upload-types.ts`, `src/api/routes/files/**`, `web/src/stores/uploads.svelte.ts`, `web/src/components/*Upload*` | Storage service, managed uploads, org-scoped files, presigned URLs, type allowlist, cross-tenant key contract |
| `landing.md` | `landing/**`, `src/lib/landing-site.ts` | The homepage at `/`, placeholder copy, app-first products, where front ends may live, brand colors on the landing site |
| `security.md` | `src/api/**`, `src/auth/**`, `src/services/**`, `app.ts` | Tenant scoping, route authorization, redirects, SSRF, injection, secrets and codes out of logs, uploads and decompression, CSV and link safety, CORS, member text in prompts |
| `ssr.md` | `src/services/ssr/**`, `src/services/storefront/**`, `web/src/islands/**`, `optional-session.ts`, `spa-shell.ts` | Server-rendered public pages: route-module discovery, escaping, JSON-LD, design tokens, `optionalSession`, caching, Svelte islands |

In Claude Code these load when you read a matching file. The Alchemist
build agent injects them when a tool call touches a matching path (and
exposes them via the `load_skill` tool). Add a new spoke by dropping a
`.claude/rules/<name>.md` with a `description:` and `paths:` frontmatter.
