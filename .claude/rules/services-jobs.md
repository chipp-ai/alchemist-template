---
name: services-jobs
description: Services + background jobs — one-service-per-domain structure, the logging contract (no bare console.error / no silent catch), and the AppError class table. Load when writing service or job code.
paths:
  - "src/services/**"
  - "src/jobs/**"
  - "src/lib/logger.ts"
  - "src/utils/errors.ts"
---

# Services + background jobs

Authoritative for `src/services/` and `src/jobs/`.

## Services

Services live in `src/services/`. One service per domain (e.g.
`user.service.ts`, `billing.service.ts`). Services contain all business
logic and database queries. Routes call services — they never query the
database directly. (DB conventions: see the `database` rule.)

## Logging contract (server-side)

- **Never use bare `console.error`.** Use `log` from `src/lib/logger.ts` with a `source` context.
- **Always pass the `Error` as the 3rd arg** to `log.error()` / `log.warn()` so the stack trace is extracted.
- **Never use bare `.catch(() => {})`** — always log failures. Silent swallowing hides bugs.

```typescript
import { log } from "@/lib/logger.ts";

// Good
try {
  await riskyOperation();
} catch (err) {
  log.error("Operation failed", { source: "billing", orgId }, err);
  throw err;
}

// Bad -- silent swallowing
await riskyOperation().catch(() => {});
```

## Error classes

Use `AppError` subclasses from `src/utils/errors.ts`:

| Class | Status | When |
|-------|--------|------|
| `BadRequestError` | 400 | Invalid input |
| `UnauthorizedError` | 401 | Not authenticated |
| `ForbiddenError` | 403 | Not authorized |
| `NotFoundError` | 404 | Resource not found |
| `ConflictError` | 409 | Duplicate / conflict |
| `ExternalServiceError` | 502 | Third-party API failure |

Throw the right subclass from a service; the route's catch block re-throws
`AppError` subclasses without logging (the global error handler logs them).
Don't `c.json({ error })` by hand for these — let the handler format them.

## Background jobs (`src/jobs/`)

One in-process runner per replica (`runner.ts`) ticks every `JOBS_TICK_MS`
and does two things in order: run due `scheduled_jobs` rows, then deliver
due `email_outbox` rows. Both claims use `FOR UPDATE SKIP LOCKED`, so every
replica runs the loop and none double-processes. There is no leader and no
Redis.

- **Handlers** live in `src/jobs/handlers/<kind>.ts`, register with
  `defineJob(kind, handler, { description })`, and are imported from
  `src/jobs/index.ts` (the import IS the registration — forget it and the
  schedule fails with "no handler registered").
- **Handler contract:** idempotent (a stale-lock re-run is possible), finishes
  inside `JOBS_HANDLER_TIMEOUT_MS`, does its work by enqueueing, returns
  `{ summary }`. Throw to mark the run failed; the schedule still advances.
- **Never `sendEmail` from a job.** Render with `renderEmailKind(kind, data)`
  (register the kind once at module load) and deliver with
  `ctx.enqueueEmail({..., idempotencyKey: ctx.idempotencyKey(recipientId) })`.
  `src/jobs/handlers/org-digest.ts` is the worked example.
- **Schedules** are rows, not code: `createScheduledJob({ kind, cron,
  timezone, organizationId, payload })`. Validation rejects unknown kinds,
  bad cron, unknown IANA zones, and cadences under `JOBS_MIN_INTERVAL_SECONDS`.
- **Catch-up policy:** `next_run_at` advances from the tick clock, so a job
  missed N times while the app was down runs once. Track a cursor in
  `payload` if every window matters.
- **Run records** go to `job_history` (`job_type = kind`, status
  completed/failed, `result` = the handler's return, `error` = message).
- **Never start the runner from a test or a script.** `main.ts` starts it
  when `JOBS_ENABLED` is not `0`; tests call `runDueScheduledJobs({ now })`
  and `deliverDueEmails({ now })` directly with an injected clock.
- **Logging:** `source: "jobs"` for the runner + schedule service,
  `source: "email-outbox"` for delivery. A permanently failed email is
  `log.error` (it will page via the platform's error-rate alert); a retry
  is `log.warn`.
