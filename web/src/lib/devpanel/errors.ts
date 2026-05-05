/**
 * Client-side error ring buffer for the dev panel.
 *
 * Catches:
 *   - window.onerror (uncaught synchronous errors)
 *   - window.onunhandledrejection (uncaught promise rejections)
 *   - Manual reports via `reportClientError(err)` from app code
 *
 * Holds the last 10 in memory. The dev-panel snapshot reads from
 * here; the production `lib/client-errors.ts` shipper (which posts
 * to /api/client-errors → Loki) is a separate path.
 *
 * No-op in production (`import.meta.env.PROD`) — we don't want a
 * ring buffer of memory-resident errors in customer-facing builds.
 */

export interface ClientErrorRecord {
  timestamp: string;
  message: string;
  stack?: string;
  /** Where the error came from: "onerror", "unhandledrejection", "manual". */
  source: string;
}

const MAX_BUFFER = 10;
const BUFFER: ClientErrorRecord[] = [];

let installed = false;

/**
 * Install the global error listeners. Idempotent. Called once from
 * `initDevPanel()`. No-op in production.
 */
export function installClientErrorListeners(): void {
  if (installed) return;
  if (typeof window === "undefined") return;
  if (import.meta.env.PROD) return;
  installed = true;

  window.addEventListener("error", (event) => {
    pushError({
      message: event.message || "Unknown window error",
      stack: event.error instanceof Error ? event.error.stack : undefined,
      source: "onerror",
    });
  });

  window.addEventListener("unhandledrejection", (event) => {
    const reason = event.reason;
    pushError({
      message:
        reason instanceof Error
          ? reason.message
          : typeof reason === "string"
          ? reason
          : "Unhandled rejection",
      stack: reason instanceof Error ? reason.stack : undefined,
      source: "unhandledrejection",
    });
  });
}

/**
 * Manual error report — call from a try/catch when you want the
 * dev panel to surface a caught error.
 */
export function reportClientError(err: unknown, source = "manual"): void {
  if (import.meta.env.PROD) return;
  pushError({
    message: err instanceof Error ? err.message : String(err),
    stack: err instanceof Error ? err.stack : undefined,
    source,
  });
}

/**
 * Read the current ring buffer. Most-recent first.
 */
export function getRecentClientErrors(): ClientErrorRecord[] {
  // Return a fresh array so callers can't mutate the buffer.
  return [...BUFFER];
}

/**
 * Test-only: clear the buffer between tests.
 */
export function __resetErrorsForTests(): void {
  BUFFER.length = 0;
  installed = false;
}

function pushError(record: Omit<ClientErrorRecord, "timestamp">): void {
  BUFFER.unshift({
    timestamp: new Date().toISOString(),
    ...record,
  });
  if (BUFFER.length > MAX_BUFFER) {
    BUFFER.length = MAX_BUFFER;
  }
}
