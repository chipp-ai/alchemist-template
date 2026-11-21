/**
 * A small circuit breaker for background pollers (the dev panel heartbeat,
 * the breadcrumb collector, query refetch intervals).
 *
 * Why: a Builder preview iframe whose sandbox paused kept polling for an
 * hour, about 2,769 requests an hour, every one a 404. A poller that cannot
 * reach its server must slow down and then stop.
 *
 * The rules:
 *   - A failure is a network error or HTTP 404, 410, 502 or 503.
 *   - After 3 failures in a row, wait before the next try: 5s, 10s, 20s,
 *     and so on, never more than 5 minutes.
 *   - After 10 failures in a row, stop. `wake()` (the page became visible
 *     again, or the hash changed) allows exactly one more try.
 *   - Any success resets the breaker.
 *
 * Pure (no DOM at import) so Deno tests can drive it with a fake clock.
 * `wakeOnPageReturn` is the only part that touches the page.
 */

export interface BreakerOptions {
  /** Failures in a row before backoff starts. Default 3. */
  backoffAfter?: number;
  /** Failures in a row before the breaker stops. Default 10. */
  stopAfter?: number;
  /** First backoff delay. Default 5s. */
  baseDelayMs?: number;
  /** Longest backoff delay. Default 5 minutes. */
  maxDelayMs?: number;
  /** Clock, for tests. */
  now?: () => number;
}

export interface CircuitBreaker {
  /** True when a request may go out now. A question only: it changes nothing. */
  canAttempt(): boolean;
  /**
   * Call right before sending. True when the request may go out; after a
   * stop it uses up the one try that wake() allowed, so two pollers that
   * share a breaker cannot both send while the first result is pending.
   */
  tryAttempt(): boolean;
  recordSuccess(): void;
  recordFailure(): void;
  /** Report a settled response: failure statuses count, anything else resets. */
  recordResponse(status: number): void;
  /** Allow one try after a stop (page visible again, hash changed). */
  wake(): void;
  readonly failures: number;
  readonly stopped: boolean;
  /** Epoch ms before which canAttempt() is false (0 = no wait). */
  readonly nextAttemptAt: number;
}

const FAILURE_STATUSES = new Set([404, 410, 502, 503]);

/** True for a status that means "the server is gone", not "the request was wrong". */
export function isBreakerFailureStatus(status: number): boolean {
  return FAILURE_STATUSES.has(status);
}

/**
 * True when a thrown error means the server is unreachable: a network
 * error (fetch rejects with a TypeError) or an error carrying a failure
 * `status` (the SPA's ApiError).
 */
export function isBreakerFailureError(err: unknown): boolean {
  if (err instanceof TypeError) return true;
  const status = (err as { status?: unknown } | null)?.status;
  return typeof status === "number" && isBreakerFailureStatus(status);
}

/** The wait after `failures` failures in a row (0 = no wait). */
export function backoffDelayMs(failures: number, opts: BreakerOptions = {}): number {
  const after = opts.backoffAfter ?? 3;
  const base = opts.baseDelayMs ?? 5_000;
  const max = opts.maxDelayMs ?? 5 * 60_000;
  if (failures < after) return 0;
  return Math.min(max, base * 2 ** (failures - after));
}

export function createCircuitBreaker(opts: BreakerOptions = {}): CircuitBreaker {
  const stopAfter = opts.stopAfter ?? 10;
  const now = opts.now ?? (() => Date.now());
  let failures = 0;
  let stopped = false;
  let probeAllowed = false;
  let nextAttemptAt = 0;

  return {
    canAttempt() {
      if (stopped) return probeAllowed;
      return now() >= nextAttemptAt;
    },
    tryAttempt() {
      if (!this.canAttempt()) return false;
      if (stopped) probeAllowed = false;
      return true;
    },
    recordSuccess() {
      failures = 0;
      stopped = false;
      probeAllowed = false;
      nextAttemptAt = 0;
    },
    recordFailure() {
      failures += 1;
      probeAllowed = false;
      if (failures >= stopAfter) {
        stopped = true;
        nextAttemptAt = 0;
        return;
      }
      const delay = backoffDelayMs(failures, opts);
      nextAttemptAt = delay > 0 ? now() + delay : 0;
    },
    recordResponse(status: number) {
      if (isBreakerFailureStatus(status)) this.recordFailure();
      else this.recordSuccess();
    },
    wake() {
      if (stopped) probeAllowed = true;
    },
    get failures() {
      return failures;
    },
    get stopped() {
      return stopped;
    },
    get nextAttemptAt() {
      return nextAttemptAt;
    },
  };
}

interface PageEvents {
  addEventListener(type: string, fn: () => void): void;
  removeEventListener(type: string, fn: () => void): void;
}

/** A browser global, or undefined under Deno (no DOM lib in the server's type check). */
function pageGlobal<T>(name: "window" | "document"): T | undefined {
  return (globalThis as Record<string, unknown>)[name] as T | undefined;
}

/**
 * Wake `breaker` when the page becomes visible again or the hash changes.
 * Returns a function that removes the listeners. No-op outside a browser.
 */
export function wakeOnPageReturn(
  breaker: CircuitBreaker,
  win: PageEvents | undefined = pageGlobal<PageEvents>("window"),
  doc: (PageEvents & { visibilityState?: string }) | undefined = pageGlobal("document"),
): () => void {
  if (!win || !doc) return () => {};
  const onHash = () => breaker.wake();
  const onVisibility = () => {
    if (doc.visibilityState === "visible") breaker.wake();
  };
  win.addEventListener("hashchange", onHash);
  doc.addEventListener("visibilitychange", onVisibility);
  return () => {
    win.removeEventListener("hashchange", onHash);
    doc.removeEventListener("visibilitychange", onVisibility);
  };
}
