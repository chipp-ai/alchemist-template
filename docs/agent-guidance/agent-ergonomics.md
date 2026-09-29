# Agent ergonomics: small, checkable changes

## Config-driven content

Product copy and identity live in `src/config/`, not scattered in
components:

- `src/config/brand.ts`: product name, sender identity, links. The only
  source of the customer-facing brand (see the "Brand identity" section of
  `CLAUDE.md`). Never hardcode "Alchemist" or a platform domain.
- `src/config/site.ts`, `src/config/llm.ts`, `src/config/demo-mode.ts`: the
  other config seams.
- The look comes from `web/src/design/design.json` (`.claude/rules/design.md`).

Change a value in one config file rather than editing every page that shows
it.

## data-testid

Every interactive element gets `data-testid="{area}-{component}-{element}"`
(for example `settings-form-input-name`). Tests and browser checks select by
it, so a missing or renamed id breaks verification.

## Local stack

`./scripts/dev.sh --api-port <port> --port <port>` starts the API, Vite and
local services. Both ports are required so parallel agents do not collide.
Logs and the observability stream land in `.scratch/logs/`. The dev
affordances (instant login, seed, reset) are in the "Dev affordances" section
of `CLAUDE.md`; use them instead of reverse-engineering auth.

## Before you finish

`deno task check`, `deno task check:tests`, `deno lint`, then the tests for
what you touched (`deno task test` runs all of `src/__tests__/`).
`CLAUDE.md` and the `.claude/rules/` spokes are the conventions; read the
spoke for the area you change.
