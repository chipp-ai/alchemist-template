/**
 * Chipp Payments donations: the browser helpers (amount parsing, the return
 * link, the thank-you line), the broker client (a donor's amount and
 * frequency, no buyer ref, no full URL), the public routes, and the
 * `chipp_donations` mirror ordered by Chipp's seq. Ships with the
 * chipp-payments pack.
 *
 * The broker is stubbed with __setChippPaymentsFetchForTest; no test calls
 * Chipp or Stripe.
 */

import { assert, assertEquals, assertRejects } from "@std/assert";
import { Hono } from "hono";
import { sql } from "kysely";
import { db } from "@/db/client.ts";
import { __deleteEnvForTest, __setEnvForTest, getEnv } from "@/lib/env.ts";
import {
  __setChippPaymentsFetchForTest,
  lookupChippDonation,
  startChippDonation,
} from "@/lib/chipp-payments.ts";
import { chippPaymentsRoutes, DONATION_THANK_YOU_PATH } from "@/api/routes/chipp-payments/index.ts";
import { applyChippDonation, confirmChippDonation, listChippDonations } from "@/services/chipp-donations.ts";
import { applyChippEntitlement } from "@/services/chipp-entitlements.ts";
import {
  DONATION_THANK_YOU_RETURN_PATH,
  donationAmountError,
  formatDonationAmount,
  parseAmountToCents,
  readDonationReturn,
  thankYouLine,
} from "../../../web/src/lib/chipp-donations.ts";

const HAS_DB = !!(getEnv("TEST_DATABASE_URL") || getEnv("DATABASE_URL"));
function dbTest(name: string, fn: () => Promise<void>) {
  Deno.test({ name, ignore: !HAS_DB, sanitizeResources: false, sanitizeOps: false, fn });
}

const ENV_KEYS = [
  "CHIPP_PAYMENTS_URL",
  "CHIPP_PAYMENTS_TOKEN",
  "CHIPP_PAYMENTS_MODE",
  "CHIPP_PAYMENTS_SCOPE",
  "CHIPP_PAYMENTS_PROJECT_ID",
  "CHIPP_PAYMENTS_ORG_ID",
  "STRIPE_SECRET_KEY",
];

async function withEnv(vars: Record<string, string | undefined>, fn: () => Promise<void> | void) {
  const prev = Object.fromEntries(ENV_KEYS.map((k) => [k, getEnv(k)]));
  for (const k of ENV_KEYS) __deleteEnvForTest(k);
  for (const [k, v] of Object.entries(vars)) if (v !== undefined) __setEnvForTest(k, v);
  try {
    await fn();
  } finally {
    for (const k of ENV_KEYS) {
      if (prev[k] === undefined) __deleteEnvForTest(k);
      else __setEnvForTest(k, prev[k]!);
    }
  }
}

const ON = {
  CHIPP_PAYMENTS_URL: "https://platform.chipp.test/",
  CHIPP_PAYMENTS_TOKEN: "tok_abc",
  CHIPP_PAYMENTS_MODE: "live",
  CHIPP_PAYMENTS_SCOPE: "deploy",
  CHIPP_PAYMENTS_PROJECT_ID: "11111111-1111-4111-8111-111111111111",
  CHIPP_PAYMENTS_ORG_ID: "22222222-2222-4222-8222-222222222222",
};

interface Captured {
  path: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

function stubBroker(routes: Record<string, (body: unknown) => { status?: number; json: unknown }>) {
  const calls: Captured[] = [];
  __setChippPaymentsFetchForTest((input, init) => {
    const url = String(input);
    const path = new URL(url).pathname.replace("/api/internal/payments-broker", "");
    calls.push({
      path,
      method: init?.method ?? "GET",
      headers: Object.fromEntries(new Headers(init?.headers).entries()),
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    });
    const handler = routes[path];
    if (!handler) return Promise.resolve(new Response(JSON.stringify({ error: "nope" }), { status: 404 }));
    const r = handler(calls[calls.length - 1].body);
    return Promise.resolve(new Response(JSON.stringify(r.json), { status: r.status ?? 200 }));
  });
  return { calls, restore: () => __setChippPaymentsFetchForTest() };
}

const app = new Hono().route("/api/chipp-payments", chippPaymentsRoutes);
const post = (path: string, body: unknown) =>
  app.request(`/api/chipp-payments${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

// ── browser helpers ────────────────────────────────────────────────────────

Deno.test("donations: typed amounts become whole cents; junk is refused", () => {
  assertEquals(parseAmountToCents("25"), 2500);
  assertEquals(parseAmountToCents("25.5"), 2550);
  assertEquals(parseAmountToCents(" $1,000.05 "), 100005);
  assertEquals(parseAmountToCents(40), 4000);
  for (const bad of ["", "abc", "1.234", "-5", "0", "0.00", "1e3", null, undefined, "1000000"]) {
    assertEquals(parseAmountToCents(bad as string), null, String(bad));
  }
});

Deno.test("donations: amount errors, money format and the thank-you line", () => {
  const p = { minAmountCents: 500, currency: "usd" };
  assertEquals(donationAmountError(null, p), "Enter an amount.");
  assertEquals(donationAmountError(499, p), "The smallest gift is $5.");
  assertEquals(donationAmountError(500, p), null);
  assertEquals(formatDonationAmount(2500), "$25");
  assertEquals(formatDonationAmount(2550), "$25.50");
  assertEquals(thankYouLine({ amountCents: 2500, currency: "usd", interval: null }), "Thank you for your gift of $25.");
  assertEquals(thankYouLine({ amountCents: 2500, currency: "usd", interval: "month" }), "Thank you for your monthly gift of $25.");
});

Deno.test("donations: the return link names the gift; anything else is not a gift", () => {
  const purchaseId = "33333333-3333-4333-8333-333333333333";
  const href = `https://app.test/app/?chipp_checkout=success&chipp_purchase=${purchaseId}&session_id=cs_live_abc123#/donate/thank-you`;
  assertEquals(readDonationReturn(href), { purchaseId, sessionId: "cs_live_abc123" });
  // The query may also sit inside the hash route.
  assertEquals(
    readDonationReturn(`https://app.test/app/#/donate/thank-you?chipp_purchase=${purchaseId}&session_id=cs_test_x`),
    { purchaseId, sessionId: "cs_test_x" },
  );
  assertEquals(readDonationReturn("https://app.test/app/#/donate/thank-you"), null);
  assertEquals(readDonationReturn(`https://app.test/?chipp_purchase=${purchaseId}&session_id={CHECKOUT_SESSION_ID}`), null);
  assertEquals(readDonationReturn(`https://app.test/?chipp_purchase=nope&session_id=cs_x`), null);
  assertEquals(readDonationReturn("not a url"), null);
  // The server default and the browser default point at the same page.
  assertEquals(DONATION_THANK_YOU_PATH, DONATION_THANK_YOU_RETURN_PATH);
});

// ── broker client ──────────────────────────────────────────────────────────

Deno.test("donations: the client sends the donor's amount and frequency, the bound headers, no buyer ref", async () => {
  await withEnv(ON, async () => {
    const { calls, restore } = stubBroker({
      "/donation-checkout": () => ({ json: { ok: true, url: "https://checkout.stripe.test/d", purchaseId: "p", testMode: false } }),
    });
    try {
      const res = await startChippDonation({ productKey: "donate", amountCents: 2500, frequency: "month", returnPath: "/app/#/donate/thank-you" });
      assertEquals(res.url, "https://checkout.stripe.test/d");
      const c = calls[0];
      assertEquals([c.path, c.method], ["/donation-checkout", "POST"]);
      assertEquals(c.headers["x-chipp-payments-auth"], "tok_abc");
      assertEquals(c.headers["x-chipp-payments-org"], ON.CHIPP_PAYMENTS_ORG_ID);
      assertEquals(Object.keys(c.body as object).sort(), ["amountCents", "frequency", "productKey", "returnPath"]);
    } finally {
      restore();
    }
  });
});

Deno.test("donations: a refused lookup surfaces as a 400-class error, not a crash", async () => {
  await withEnv(ON, async () => {
    const { restore } = stubBroker({ "/donation-lookup": () => ({ status: 404, json: { ok: false, error: "Donation not found" } }) });
    try {
      await assertRejects(() => lookupChippDonation({ purchaseId: crypto.randomUUID(), sessionId: "cs_x" }), Error, "not found");
    } finally {
      restore();
    }
  });
});

// ── public routes ──────────────────────────────────────────────────────────

Deno.test("donations route: anyone can start a gift; it returns to the thank-you page by default", async () => {
  await withEnv(ON, async () => {
    const { calls, restore } = stubBroker({
      "/donation-checkout": () => ({ json: { ok: true, url: "https://checkout.stripe.test/d", purchaseId: "p", testMode: false } }),
    });
    try {
      // No session cookie at all: a donor has no account.
      const res = await post("/donate", { productKey: "donate", amountCents: "25.4", frequency: "one_time" });
      assertEquals(res.status, 200);
      assertEquals((await res.json()).data.url, "https://checkout.stripe.test/d");
      const body = calls[0].body as Record<string, unknown>;
      assertEquals(body.amountCents, 25);
      assertEquals(body.returnPath, DONATION_THANK_YOU_PATH);
      // A full URL from the browser is reduced to a same-origin path.
      await post("/donate", { productKey: "donate", amountCents: 500, frequency: "month", returnPath: "https://evil.test/x" });
      assertEquals((calls[1].body as Record<string, unknown>).returnPath, "/x");
    } finally {
      restore();
    }
  });
});

Deno.test("donations route: a bad frequency or amount is a 400 and never reaches Chipp", async () => {
  await withEnv(ON, async () => {
    const { calls, restore } = stubBroker({});
    try {
      assertEquals((await post("/donate", { productKey: "donate", amountCents: 500, frequency: "weekly" })).status, 400);
      assertEquals((await post("/donate", { productKey: "donate", amountCents: -5, frequency: "one_time" })).status, 400);
      assertEquals((await post("/donation/confirm", { purchaseId: "nope", sessionId: "cs_x" })).status, 400);
      assertEquals(calls.length, 0);
    } finally {
      restore();
    }
  });
});

Deno.test("donations route: the catalog is public and says when donations are off", async () => {
  await withEnv({}, async () => {
    const res = await app.request("/api/chipp-payments/donations");
    assertEquals(res.status, 200);
    assertEquals((await res.json()).data, { active: false, testMode: false, sandboxAccount: false, donations: [] });
  });
  await withEnv(ON, async () => {
    const donation = {
      key: "donate",
      name: "Donate",
      description: null,
      kind: "donation",
      currency: "usd",
      minAmountCents: 500,
      suggestedAmountsCents: [2500],
      frequencies: ["one_time", "month"],
    };
    const { restore } = stubBroker({
      "/products": () => ({ json: { ok: true, mode: "live", testMode: false, sandboxAccount: false, products: [], donations: [donation] } }),
    });
    try {
      const res = await app.request("/api/chipp-payments/donations");
      assertEquals((await res.json()).data.donations, [donation]);
    } finally {
      restore();
    }
  });
});

// ── the mirror ─────────────────────────────────────────────────────────────

async function donationRow(purchaseId: string) {
  const res = await sql<{ status: string; chippSeq: string; donorEmail: string | null; billingInterval: string | null; amountCents: number }>`
    SELECT status, chipp_seq AS "chippSeq", donor_email AS "donorEmail", billing_interval AS "billingInterval",
           amount_cents AS "amountCents"
    FROM chipp_donations WHERE chipp_purchase_id = ${purchaseId}
  `.execute(db);
  return res.rows[0] ?? null;
}

function gift(over: Record<string, unknown> = {}) {
  return {
    purchaseId: crypto.randomUUID(),
    productKey: "donate",
    kind: "donation",
    customerRef: `donor:${crypto.randomUUID()}`,
    mode: "live",
    status: "active",
    entitled: true,
    interval: "month",
    donorEmail: "donor@example.org",
    amountCents: 2500,
    currency: "usd",
    currentPeriodEnd: null,
    seq: 1,
    ...over,
  };
}

dbTest("donations mirror: the inbox event lands in chipp_donations, ordered by seq, never in purchases", async () => {
  await withEnv(ON, async () => {
    const g = gift();
    try {
      assertEquals(await applyChippEntitlement(g), "applied");
      let row = await donationRow(g.purchaseId);
      assertEquals([row?.status, row?.donorEmail, row?.billingInterval, Number(row?.amountCents)], ["active", "donor@example.org", "month", 2500]);
      // An older state arriving late is ignored; a newer one applies.
      assertEquals(await applyChippEntitlement({ ...g, status: "past_due", seq: 1 }), "stale");
      assertEquals(await applyChippEntitlement({ ...g, status: "canceled", entitled: false, seq: 3 }), "applied");
      row = await donationRow(g.purchaseId);
      assertEquals([row?.status, Number(row?.chippSeq)], ["canceled", 3]);
      const purchases = await db.selectFrom("purchases").select(["id"]).where("chippPurchaseId", "=", g.purchaseId).execute();
      assertEquals(purchases.length, 0);
      const listed = await listChippDonations(500);
      assert(listed.some((d) => d.chippPurchaseId === g.purchaseId && d.billingInterval === "month"));
    } finally {
      await sql`DELETE FROM chipp_donations WHERE chipp_purchase_id = ${g.purchaseId}`.execute(db);
    }
  });
});

dbTest("donations mirror: a test-mode gift never lands in a live app", async () => {
  await withEnv(ON, async () => {
    const g = gift({ mode: "test" });
    assertEquals(await applyChippDonation(g), "other_mode");
    assertEquals(await donationRow(g.purchaseId), null);
  });
});

dbTest("donations confirm: the thank-you page mirrors a settled gift and returns only what it shows", async () => {
  await withEnv(ON, async () => {
    const purchaseId = crypto.randomUUID();
    const { calls, restore } = stubBroker({
      "/donation-lookup": () => ({
        json: {
          ok: true,
          donation: {
            purchaseId,
            productKey: "donate",
            status: "active",
            amountCents: 4200,
            currency: "usd",
            interval: null,
            recurring: false,
            canManage: false,
            donorEmail: "donor@example.org",
            currentPeriodEnd: null,
            seq: 2,
          },
        },
      }),
    });
    try {
      const res = await post("/donation/confirm", { purchaseId, sessionId: "cs_live_abc" });
      assertEquals(res.status, 200);
      const data = (await res.json()).data;
      assertEquals(data, { status: "active", amountCents: 4200, currency: "usd", interval: null, recurring: false, canManage: false });
      assertEquals(calls[0].body, { purchaseId, sessionId: "cs_live_abc" });
      const row = await donationRow(purchaseId);
      assertEquals([row?.status, Number(row?.chippSeq), row?.donorEmail], ["active", 2, "donor@example.org"]);
      // A pending gift is shown but not mirrored.
      const pendingId = crypto.randomUUID();
      restore();
      const again = stubBroker({
        "/donation-lookup": () => ({
          json: { ok: true, donation: { purchaseId: pendingId, productKey: "donate", status: "pending", amountCents: 100, currency: "usd", interval: null, recurring: false, canManage: false, seq: 0 } },
        }),
      });
      try {
        assertEquals((await confirmChippDonation({ purchaseId: pendingId, sessionId: "cs_live_x" })).status, "pending");
        assertEquals(await donationRow(pendingId), null);
      } finally {
        again.restore();
      }
    } finally {
      restore();
      await sql`DELETE FROM chipp_donations WHERE chipp_purchase_id = ${purchaseId}`.execute(db);
    }
  });
});
