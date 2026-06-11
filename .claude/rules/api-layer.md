---
name: api-layer
description: HTTP API conventions — Hono route structure, zValidator + validationHook, the {data}/{error} response envelope, and the realtime/WebSocket surface. Load when adding or editing API routes.
paths:
  - "src/api/**"
  - "src/routes/**"
---

# API layer conventions

Authoritative for anything under `src/api/`. Routes are thin
orchestration; business logic lives in services (see the `services-jobs`
rule).

## Route structure

Routes live in `src/api/routes/`. Each route file exports a Hono app
mounted in the main router. Routes orchestrate; they never query the DB
directly — they call services.

```typescript
import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { validationHook } from "@/utils/zod-validation-hook.ts";

const app = new Hono();

app.get("/items", async (c) => {
  const items = await itemService.list();
  return c.json({ data: items });
});

app.post(
  "/items",
  zValidator("json", createItemSchema, validationHook),
  async (c) => {
    const body = c.req.valid("json");
    const item = await itemService.create(body);
    return c.json({ data: item }, 201);
  },
);

export default app;
```

## Request validation

- **`zValidator` MUST always pass `validationHook`** as the third argument. Without it, validation errors return a raw ZodError object and clients see `[object Object]` instead of a readable message.
- **Zod `.trim()` before `.min(1)` for name fields.** `z.string().min(1)` passes whitespace-only strings (`"   "` has length 3). Chain `.trim().min(1)` for user-facing name/label fields. Do not trim passwords or API keys.

## Response format

All endpoints return:
- **Success:** `{ data: T }` with appropriate status code (200, 201, 204)
- **Error:** `{ error: string, code: string }` with appropriate status code

Route catch blocks should re-throw `AppError` subclasses without logging
(the global error handler logs them). See the `services-jobs` rule for the
error-class table.

## Auth on routes

Protected routes use `requireAuth` middleware, which populates
`c.get("user")` and `c.get("session")`. Capability-gated routes use
`requireCapability("...")`. Both live in `src/api/middleware/auth.ts` —
see the `auth` rule for the role hierarchy + capability set.

## Realtime / WebSockets

The template ships a working WS surface so customer apps don't plumb auth
+ connection lifecycle from scratch:

- **`GET /api/auth/ws-token`** (auth-required) mints a 60-second JWT with `scope: "ws"`. Cookies don't reliably travel on cross-origin WS handshakes, so this token is the canonical way to authenticate a WS connection.
- **`GET /api/realtime/ws?token=<wsToken>`** verifies the token via `verifyWsToken` (`src/api/middleware/auth.ts`), upgrades the request, and runs a baseline echo loop (`src/api/routes/realtime/index.ts`). On open it sends `{ type: "hello", userId, organizationId, connectionId }`; on each text frame it replies `{ type: "echo", ... }`.

Add real features by replacing **the `socket.onmessage` branch** in
`src/api/routes/realtime/index.ts`. Keep the auth + open + close handlers
intact — they are load-bearing for attribution + log correlation.

**Scope segregation is enforced both ways**: `verifyToken` (session
middleware) rejects `scope: "ws"` tokens so an exfiltrated WS token can't
be used as a session cookie, and `verifyWsToken` rejects session tokens so
a leaked session cookie can't open a WS to another tenant.

```ts
// 1. Fetch a fresh token (uses the session cookie).
const { token } = await api.get<{ token: string }>("/auth/ws-token");
// 2. Open the WS with the token in the query string.
const ws = new WebSocket(`ws://${location.host}/api/realtime/ws?token=${encodeURIComponent(token)}`);
ws.onopen = () => ws.send("hello server");
ws.onmessage = (ev) => console.log("server →", ev.data);
```
