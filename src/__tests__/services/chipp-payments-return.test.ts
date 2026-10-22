/**
 * Chipp Payments checkout return: a gated page waits for the sale to settle
 * instead of showing the lock until a reload. Pure logic, no DB.
 */

import { assertEquals, assertRejects } from "@std/assert";
import {
  CHECKOUT_RETURN_DELAYS_MS,
  confirmPurchase,
  withoutCheckoutMarker,
} from "../../../web/src/lib/chipp-payments-return.ts";

function recorder() {
  const calls: string[] = [];
  const slept: number[] = [];
  return {
    calls,
    slept,
    sleep: (ms: number) => {
      slept.push(ms);
      return Promise.resolve();
    },
  };
}

Deno.test("checkout return: a normal visit reads once and never syncs", async () => {
  const r = recorder();
  const unlocked = await confirmPurchase({
    isReturn: false,
    sync: () => {
      r.calls.push("sync");
      return Promise.resolve();
    },
    check: () => {
      r.calls.push("check");
      return Promise.resolve(false);
    },
    sleep: r.sleep,
  });
  assertEquals(unlocked, false);
  assertEquals(r.calls, ["check"]);
  assertEquals(r.slept, []);
});

Deno.test("checkout return: syncs before the first read, so a settled sale unlocks at once", async () => {
  const r = recorder();
  let settled = false;
  const unlocked = await confirmPurchase({
    isReturn: true,
    sync: () => {
      r.calls.push("sync");
      settled = true;
      return Promise.resolve();
    },
    check: () => {
      r.calls.push("check");
      return Promise.resolve(settled);
    },
    sleep: r.sleep,
  });
  assertEquals(unlocked, true);
  assertEquals(r.calls, ["sync", "check"]);
  assertEquals(r.slept, []);
});

Deno.test("checkout return: a sale that settles late unlocks after backoff, without a reload", async () => {
  const r = recorder();
  let reads = 0;
  const syncAttempts: number[] = [];
  const unlocked = await confirmPurchase({
    isReturn: true,
    sync: (attempt) => {
      syncAttempts.push(attempt);
      return Promise.resolve();
    },
    check: () => Promise.resolve(++reads >= 3),
    sleep: r.sleep,
  });
  assertEquals(unlocked, true);
  assertEquals(reads, 3);
  assertEquals(syncAttempts, [0, 1, 2]);
  assertEquals(r.slept, [500, 1000]);
});

Deno.test("checkout return: gives up as locked when the sale never settles", async () => {
  const r = recorder();
  let reads = 0;
  const unlocked = await confirmPurchase({
    isReturn: true,
    sync: () => Promise.resolve(),
    check: () => {
      reads++;
      return Promise.resolve(false);
    },
    sleep: r.sleep,
  });
  assertEquals(unlocked, false);
  assertEquals(reads, CHECKOUT_RETURN_DELAYS_MS.length + 1);
  assertEquals(r.slept, [...CHECKOUT_RETURN_DELAYS_MS]);
});

Deno.test("checkout return: a failed sync is only 'not yet'; the read still decides", async () => {
  const r = recorder();
  let syncs = 0;
  const unlocked = await confirmPurchase({
    isReturn: true,
    sync: () => {
      syncs++;
      if (syncs === 1) throw new Error("thrown before a promise");
      return Promise.reject(new Error("broker down"));
    },
    check: () => Promise.resolve(syncs >= 2),
    sleep: r.sleep,
    delaysMs: [10, 20],
  });
  assertEquals(unlocked, true);
  assertEquals(r.slept, [10]);
});

Deno.test("checkout return: an error from the access read is a real error and is thrown", async () => {
  const r = recorder();
  await assertRejects(
    () =>
      confirmPurchase({
        isReturn: true,
        sync: () => Promise.resolve(),
        check: () => Promise.reject(new Error("500")),
        sleep: r.sleep,
      }),
    Error,
    "500",
  );
});

Deno.test("checkout return: the return parameters are removed and the hash route stays", () => {
  assertEquals(
    withoutCheckoutMarker(
      "https://app.example/?chipp_checkout=success&chipp_purchase=p1&session_id=cs_test_1&ref=x#/pro",
    ),
    "https://app.example/?ref=x#/pro",
  );
  assertEquals(
    withoutCheckoutMarker(
      "https://app.example/app/?chipp_checkout=success#/pro",
    ),
    "https://app.example/app/#/pro",
  );
  // Not a return: the URL is left exactly as it was, session_id included.
  assertEquals(
    withoutCheckoutMarker("https://app.example/?session_id=abc#/x"),
    "https://app.example/?session_id=abc#/x",
  );
});
