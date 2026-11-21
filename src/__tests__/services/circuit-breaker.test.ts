/**
 * The poller circuit breaker (web/src/lib/circuit-breaker.ts). A Builder
 * preview whose sandbox paused kept polling for an hour (~2,769 404s an
 * hour). After 3 failures in a row the breaker backs off (5s, 10s, 20s ...
 * 5 min); after 10 it stops until the page returns; a success resets it.
 */
import { assert, assertEquals, assertFalse } from "@std/assert";
import {
  backoffDelayMs,
  createCircuitBreaker,
  isBreakerFailureError,
  isBreakerFailureStatus,
  wakeOnPageReturn,
} from "../../../web/src/lib/circuit-breaker.ts";

function fakeClock() {
  let t = 1_000_000;
  return { now: () => t, advance: (ms: number) => (t += ms) };
}

Deno.test("breaker: which statuses and errors count as failures", () => {
  for (const s of [404, 410, 502, 503]) assert(isBreakerFailureStatus(s), String(s));
  for (const s of [200, 204, 400, 401, 403, 409, 429, 500, 504]) {
    assertFalse(isBreakerFailureStatus(s), String(s));
  }
  assert(isBreakerFailureError(new TypeError("Failed to fetch")));
  assert(isBreakerFailureError(Object.assign(new Error("x"), { status: 404 })));
  assertFalse(isBreakerFailureError(Object.assign(new Error("x"), { status: 401 })));
  assertFalse(isBreakerFailureError(new Error("boom")));
  assertFalse(isBreakerFailureError(null));
});

Deno.test("breaker: backoff doubles from 5s after 3 failures and caps at 5 minutes", () => {
  assertEquals([0, 1, 2].map((n) => backoffDelayMs(n)), [0, 0, 0]);
  assertEquals([3, 4, 5, 6].map((n) => backoffDelayMs(n)), [5_000, 10_000, 20_000, 40_000]);
  assertEquals(backoffDelayMs(9), 300_000);
  assertEquals(backoffDelayMs(50), 300_000);
});

Deno.test("breaker: two failures keep polling, the third starts the wait", () => {
  const clock = fakeClock();
  const b = createCircuitBreaker({ now: clock.now });
  b.recordFailure();
  b.recordFailure();
  assert(b.canAttempt());
  b.recordFailure();
  assertFalse(b.canAttempt());
  clock.advance(4_999);
  assertFalse(b.tryAttempt());
  clock.advance(1);
  assert(b.tryAttempt());
  b.recordResponse(404);
  assertFalse(b.canAttempt());
  clock.advance(10_000);
  assert(b.canAttempt());
});

Deno.test("breaker: ten failures stop it; wake allows exactly one try", () => {
  const clock = fakeClock();
  const b = createCircuitBreaker({ now: clock.now });
  for (let i = 0; i < 10; i++) b.recordFailure();
  assert(b.stopped);
  clock.advance(24 * 60 * 60_000);
  assertFalse(b.canAttempt(), "a stopped breaker never retries on time alone");

  b.wake();
  assert(b.canAttempt());
  assert(b.tryAttempt());
  assertFalse(b.tryAttempt(), "the probe is used up while its result is pending");

  b.recordFailure();
  assert(b.stopped);
  assertFalse(b.canAttempt());

  b.wake();
  assert(b.tryAttempt());
  b.recordResponse(200);
  assertFalse(b.stopped);
  assertEquals(b.failures, 0);
  assert(b.canAttempt());
});

Deno.test("breaker: wake does nothing while not stopped", () => {
  const clock = fakeClock();
  const b = createCircuitBreaker({ now: clock.now });
  for (let i = 0; i < 4; i++) b.recordFailure();
  b.wake();
  assertFalse(b.canAttempt(), "wake does not skip a backoff wait");
});

Deno.test("breaker: a success resets the count and the wait", () => {
  const clock = fakeClock();
  const b = createCircuitBreaker({ now: clock.now });
  for (let i = 0; i < 5; i++) b.recordFailure();
  b.recordSuccess();
  assertEquals(b.failures, 0);
  assertEquals(b.nextAttemptAt, 0);
  assert(b.canAttempt());
  // A non-failure status (the server answered) also resets.
  for (let i = 0; i < 5; i++) b.recordFailure();
  b.recordResponse(500);
  assert(b.canAttempt());
});

Deno.test("breaker: a dead server for an hour costs a handful of requests, not thousands", () => {
  const clock = fakeClock();
  const b = createCircuitBreaker({ now: clock.now });
  let sent = 0;
  // A 5s poller for one hour against a server that answers 404.
  for (let t = 0; t < 3_600_000; t += 5_000) {
    if (b.tryAttempt()) {
      sent += 1;
      b.recordResponse(404);
    }
    clock.advance(5_000);
  }
  assertEquals(sent, 10);
});

Deno.test("breaker: wakeOnPageReturn wakes on hashchange and on visible, and unsubscribes", () => {
  const win = new EventTarget();
  const doc = Object.assign(new EventTarget(), { visibilityState: "hidden" });
  const b = createCircuitBreaker();
  for (let i = 0; i < 10; i++) b.recordFailure();
  const stop = wakeOnPageReturn(b, win, doc);

  doc.dispatchEvent(new Event("visibilitychange"));
  assertFalse(b.canAttempt(), "hidden is not a return");
  doc.visibilityState = "visible";
  doc.dispatchEvent(new Event("visibilitychange"));
  assert(b.tryAttempt());
  b.recordFailure();

  win.dispatchEvent(new Event("hashchange"));
  assert(b.tryAttempt());
  b.recordFailure();

  stop();
  win.dispatchEvent(new Event("hashchange"));
  assertFalse(b.canAttempt());
});

const read = (rel: string) => Deno.readTextFile(new URL(`../../../${rel}`, import.meta.url));

Deno.test("breaker: the pollers use it, and a failing flush cannot feed another flush", async () => {
  const push = await read("web/src/lib/devpanel/push.svelte.ts");
  assert(push.includes("pushBreaker.tryAttempt()"));
  assert(push.includes("pushBreaker.recordResponse(res.status)"));
  assert(push.includes("wakeOnPageReturn(pushBreaker)"));

  const crumbs = await read("web/src/lib/observability/breadcrumbs.ts");
  assert(crumbs.includes("collectorBreaker.tryAttempt()"));
  assert(crumbs.includes("collectorBreaker.recordResponse(res.status)"));
  assert(crumbs.includes("wakeOnPageReturn(collectorBreaker)"));
  // The heartbeat POST is not instrumented, so its 404 never queues a breadcrumb.
  assert(crumbs.includes('"/api/dev/app-state"'));
  // flush() must send with the ORIGINAL fetch and log with the ORIGINAL
  // console, or a failed flush would record a breadcrumb and schedule a flush.
  const flushBody = crumbs.slice(
    crumbs.indexOf("function flush(): void"),
    crumbs.indexOf("function flushSync(): void"),
  );
  assertFalse(/\brecord\(/.test(flushBody), "flush() must not record a breadcrumb");
  assertFalse(
    /[^.]\bfetch\(/.test(flushBody.replaceAll("originalFetch.call", "")),
    "flush() must use originalFetch",
  );
  assertFalse(/\bconsole\.(warn|error|log)\(/.test(flushBody), "flush() must use originalConsole");

  const query = await read("web/src/lib/query.svelte.ts");
  assert(query.includes("entry.breaker.tryAttempt()"));
  assert(query.includes("isBreakerFailureError(err)"));
});
