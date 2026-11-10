# API conventions

## API Conventions

> **Detailed API-layer rules live in `.claude/rules/api-layer.md`** (Hono route
> structure, `zValidator` + `validationHook`, the `{data}`/`{error}` envelope,
> the realtime/WebSocket surface). They auto-load when you touch `src/api/**`.
> The essentials: routes are thin orchestration (logic lives in services),
> `zValidator` MUST pass `validationHook`, and every response is `{ data }` or
> `{ error, code }`.

## Error Handling

> **The server-side logging contract + `AppError` class table live in
> `.claude/rules/services-jobs.md`** (auto-loads on `src/services/**` /
> `src/jobs/**`). The essentials: never bare `console.error` or
> `.catch(() => {})`; use `log` from `src/lib/logger.ts` with a `source` and
> pass the `Error` as the 3rd arg; throw `AppError` subclasses and let the
> global handler format them.
