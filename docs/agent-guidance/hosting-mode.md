# Hosting mode and the build

## Two hosting modes (a platform setting, not code)

- `managed`: the platform builds the image from this repo's `Dockerfile`,
  runs it, injects env (database, SMTP, storage, `JWT_SECRET`, `APP_URL`,
  brand) and rolls deploys on every push to the default branch.
- `dispatch_only`: the builder's own CI/CD builds and deploys. The platform
  still dispatches agent work against the repo but does not deploy it.

The mode lives on the platform's project record. Nothing in this repo reads
it, and nothing here should branch on it.

## What the repo provides for either mode

- `Dockerfile`: a Node stage builds the Svelte SPA (`web/`), a Deno stage
  caches dependencies and runs `deno check main.ts`, and the runtime stage
  runs `db/migrate.ts` and then `main.ts`. `deno check` failing fails the
  image build.
- Health: `GET /health` (status, db, version) and `GET /ready` (503 until the
  database answers), in `src/api/routes/health/index.ts`. The platform's
  probes use them.
- CI: `.github/workflows/ci.yml`.

## Rules

- Never hand-roll a second Dockerfile or entrypoint for a feature. Extend the
  existing one.
- Keep `/health` and `/ready` cheap and unauthenticated.
- Configuration comes from env vars the platform sets. Read them where the
  base already does (`src/config/`), with a generic local fallback, and never
  hardcode a production URL, key or bucket name.
- Migrations run at container start, before the new code serves, while old
  pods still serve. Every migration must work with the code already running
  (expand/contract).
