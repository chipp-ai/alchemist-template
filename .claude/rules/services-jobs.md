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
