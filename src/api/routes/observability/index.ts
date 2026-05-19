/**
 * Observability collector — receives batched client breadcrumbs from
 * the in-browser instrumentation and appends them to the unified
 * JSONL stream.
 *
 * POST /api/_observability/breadcrumb
 * Body: { events: ObsEvent[] }
 *
 * Dev-only — production gates the entire mount at the app.ts level.
 * No auth in dev because the only writer is the local SPA on the
 * same origin (CORS already restricts cross-origin). When the
 * analytics product ships, this route will be replaced by a remote
 * ingest endpoint with a real auth token.
 *
 * Failure mode: the route ALWAYS returns 204 No Content, even on
 * malformed input. Observability errors must never surface to the
 * user's app as broken instrumentation — silent best-effort matches
 * the JSONL writer's contract.
 */

import { Hono } from "hono";
import { recordClientEvents } from "@/observability/envelope.ts";
import type { ObsEvent } from "@/observability/envelope.ts";

const observabilityRoutes = new Hono();

observabilityRoutes.post("/breadcrumb", async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.body(null, 204);
  }
  if (!body || typeof body !== "object") return c.body(null, 204);
  const events = (body as { events?: unknown }).events;
  if (!Array.isArray(events)) return c.body(null, 204);

  // Defensive shape check — we trust our own client script but
  // the body crosses an HTTP boundary and could be malformed during
  // a bad reload / extension injection / etc. We accept events that
  // have the minimum required fields and drop anything else.
  const valid: ObsEvent[] = [];
  for (const raw of events) {
    if (!raw || typeof raw !== "object") continue;
    const ev = raw as Partial<ObsEvent>;
    if (typeof ev.ts !== "string") continue;
    if (typeof ev.sid !== "string") continue;
    if (ev.source !== "client") continue; // collector accepts client events only
    if (typeof ev.kind !== "string") continue;
    if (!ev.data || typeof ev.data !== "object") continue;
    valid.push(ev as ObsEvent);
  }
  if (valid.length > 0) recordClientEvents(valid);
  return c.body(null, 204);
});

export { observabilityRoutes };
