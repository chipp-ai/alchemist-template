/**
 * In-memory ring buffer of recent server activity for the dev panel.
 *
 * Two buffers:
 *   - REQUESTS: last 20 HTTP requests (method, path, status, duration).
 *   - ERRORS: last 10 server-side errors (message, stack, source).
 *
 * Both are populated by the `recordRequest` / `recordError` exports
 * — wired in from the `recent-activity` middleware (requests) and the
 * platform logger's `log.error` (errors).
 *
 * Surfaced to the agent via `GET /api/dev/app-state` (in
 * src/api/routes/dev/index.ts) and to humans via the in-browser
 * DevPanel (which fetches the same endpoint).
 *
 * Production gate: this module is harmless in production (just a
 * couple of arrays) but the writers are gated by `NODE_ENV !==
 * "production"` at their call sites. The endpoint that EXPOSES the
 * data is also production-gated, so a leak would require multiple
 * misconfigurations stacking.
 */

const MAX_REQUESTS = 20;
const MAX_ERRORS = 10;

export interface DevRequestRecord {
  timestamp: string;
  method: string;
  path: string;
  routePath: string;
  status: number;
  durationMs: number;
  /** Set when the response was a 5xx OR threw an exception. */
  isError: boolean;
}

export interface DevErrorRecord {
  timestamp: string;
  message: string;
  stack?: string;
  /** "request-timing", "log.error", "uncaught", etc. */
  source: string;
  /** Method + route, when the error was tied to a specific HTTP request. */
  request?: { method: string; routePath: string; status: number };
}

const REQUESTS: DevRequestRecord[] = [];
const ERRORS: DevErrorRecord[] = [];

/**
 * Append a request record. Most-recent first. Caller is the
 * `recent-activity` middleware.
 */
export function recordRequest(record: Omit<DevRequestRecord, "timestamp">): void {
  REQUESTS.unshift({
    timestamp: new Date().toISOString(),
    ...record,
  });
  if (REQUESTS.length > MAX_REQUESTS) REQUESTS.length = MAX_REQUESTS;
}

/**
 * Append an error record. Most-recent first. Used by the platform
 * logger to mirror `log.error` calls into the dev-panel ring.
 */
export function recordError(record: Omit<DevErrorRecord, "timestamp">): void {
  ERRORS.unshift({
    timestamp: new Date().toISOString(),
    ...record,
  });
  if (ERRORS.length > MAX_ERRORS) ERRORS.length = MAX_ERRORS;
}

export function getRecentRequests(): DevRequestRecord[] {
  return [...REQUESTS];
}

export function getRecentErrors(): DevErrorRecord[] {
  return [...ERRORS];
}

/**
 * Test-only: clear both buffers between tests.
 */
export function __resetDevActivityForTests(): void {
  REQUESTS.length = 0;
  ERRORS.length = 0;
}
