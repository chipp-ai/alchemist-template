/**
 * Shared envelope for the unified observability stream.
 *
 * Every event — whether from the server logger, HTTP middleware, or
 * client breadcrumbs — lands as one JSONL line with this shape:
 *
 *   {
 *     "ts": "2026-05-19T16:30:00.123Z",
 *     "sid": "<session id>",
 *     "source": "client" | "server",
 *     "kind": "<event-type slug>",
 *     "data": { ...payload }
 *   }
 *
 * `kind` taxonomy (extend by adding new slugs, not by mutating
 * existing ones — the analytics product depends on stable slugs):
 *
 *   server.log.*       — log.info/warn/error/debug emissions
 *   server.http        — completed HTTP request (req+res pair)
 *   server.error       — uncaught request error
 *
 *   client.console.*   — captured browser console.log/info/warn/error
 *   client.error       — window.error (uncaught exception)
 *   client.promise     — unhandledrejection
 *   client.fetch       — fetch / XMLHttpRequest completed
 *   client.click       — user click (interactive element OR background)
 *   client.route       — pushState / replaceState / popstate
 *   client.perf.lcp    — Largest Contentful Paint
 *   client.perf.cls    — Cumulative Layout Shift (snapshot)
 *   client.perf.inp    — Interaction to Next Paint (snapshot)
 *   client.session     — session lifecycle (start, visibility change)
 *
 * Session id ("sid"): generated client-side per page load, stable
 * across breadcrumbs from the same SPA session. Server events use a
 * separate per-process id since the server has no notion of "user
 * session" without coupling to auth.
 */

import { appendLineSync } from "./jsonl-writer.ts";

export type ObsSource = "client" | "server";

export interface ObsEvent {
  ts: string;
  sid: string;
  source: ObsSource;
  kind: string;
  data: Record<string, unknown>;
}

/**
 * What kind of process this is, from its entry module. Only `main.ts` is the
 * dev server. A test run or a script imports the same logger and writes to
 * the same file, and must not read as a server restart: an agent saw a test's
 * "DATABASE_URL not set" under a fresh `srv-` id and chased a restart that
 * never happened.
 */
export function processSidPrefix(mainModule: string): "srv" | "test" | "script" {
  const path = mainModule.split(/[?#]/)[0];
  if (/\/main\.ts$/.test(path)) return "srv";
  if (/[._]test\.(ts|tsx|js|mjs)$/.test(path) || path.includes("/__tests__/")) return "test";
  return "script";
}

function entryModule(): string {
  try {
    return Deno.mainModule;
  } catch {
    return "";
  }
}

// Per-process session id. Stable for this process's lifetime; a new `srv-`
// id means the dev server really restarted. `test-` and `script-` ids are
// other processes sharing the log.
const SERVER_SID = `${processSidPrefix(entryModule())}-${Date.now()}-${
  Math.random().toString(36).slice(2, 8)
}`;

const IS_DEV = (() => {
  try {
    return (Deno.env.get("NODE_ENV") ?? "development") !== "production";
  } catch {
    return true;
  }
})();

/**
 * Record a server-side observability event. Fire-and-forget; never
 * throws, never blocks. No-op in production (the analytics product
 * will replace this call site when it lands).
 */
export function recordServerEvent(kind: string, data: Record<string, unknown>): void {
  if (!IS_DEV) return;
  const event: ObsEvent = {
    ts: new Date().toISOString(),
    sid: SERVER_SID,
    source: "server",
    kind,
    data,
  };
  // Best-effort JSON serialize — if data contains a cycle or BigInt,
  // we still want SOMETHING in the file rather than dropping the
  // event silently.
  let line: string;
  try {
    line = JSON.stringify(event);
  } catch {
    line = JSON.stringify({
      ...event,
      data: { _serializeError: "could not serialize event data" },
    });
  }
  appendLineSync(line);
}

/**
 * Record a batch of client breadcrumbs. The collector route calls
 * this after parsing the request body. Each event arrives pre-shaped
 * with `source: "client"` and a sid generated client-side.
 */
export function recordClientEvents(events: ObsEvent[]): void {
  if (!IS_DEV) return;
  for (const ev of events) {
    let line: string;
    try {
      line = JSON.stringify(ev);
    } catch {
      line = JSON.stringify({
        ...ev,
        data: { _serializeError: "could not serialize event data" },
      });
    }
    appendLineSync(line);
  }
}
