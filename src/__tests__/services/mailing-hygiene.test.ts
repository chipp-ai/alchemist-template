/**
 * List hygiene (src/services/mailing/hygiene.ts): the addresses a mailing
 * list must never mail. Pure, plus the bounded MX check with an injected
 * resolver (no network).
 */

import { assert, assertEquals } from "@std/assert";
import { checkAddress, checkDomainsHaveMx, normalizeAddress } from "@/services/mailing/hygiene.ts";

Deno.test("hygiene: a normal address passes, lowercased and trimmed", () => {
  const r = checkAddress("  Ada.Lovelace@Gmail.com ");
  assertEquals(r, { ok: true, email: "ada.lovelace@gmail.com" });
  assertEquals(normalizeAddress(" X@Y.COM "), "x@y.com");
});

Deno.test("hygiene: syntactically invalid addresses are refused", () => {
  for (
    const bad of ["", "n/a", "ada", "ada@", "@gmail.com", "ada@gmail", "a b@gmail.com", "a@b.c"]
  ) {
    const r = checkAddress(bad);
    assert(!r.ok, `${bad} should be invalid`);
    if (!r.ok) assertEquals(r.code, "invalid", bad);
  }
});

Deno.test("hygiene: common provider typos are flagged with the fix", () => {
  const cases: Array<[string, string]> = [
    ["pat@gmail.co", "pat@gmail.com"],
    ["pat@gmail.cm", "pat@gmail.com"],
    ["pat@tahoo.com", "pat@yahoo.com"],
    ["pat@yaho.com", "pat@yahoo.com"],
    ["pat@hotmial.com", "pat@hotmail.com"],
    ["pat@outlok.com", "pat@outlook.com"],
    ["pat@mybusiness.con", "pat@mybusiness.com"],
  ];
  for (const [input, fix] of cases) {
    const r = checkAddress(input);
    assert(!r.ok, input);
    if (!r.ok) {
      assertEquals(r.code, "typo_domain", input);
      assertEquals(r.suggestion, fix, input);
      assert(r.reason.includes(fix));
    }
  }
});

Deno.test("hygiene: real lookalike domains are NOT flagged", () => {
  for (const ok of ["pat@yahoo.co.uk", "pat@gmail.com", "pat@outlook.com", "pat@company.co"]) {
    assert(checkAddress(ok).ok, ok);
  }
});

Deno.test("hygiene: test and system addresses are refused, business inboxes are not", () => {
  for (
    const bad of [
      "probe@acme.com",
      "test@acme.com",
      "test1@acme.com",
      "test+abc@acme.com",
      "noreply@acme.com",
      "no-reply@acme.com",
      "postmaster@acme.com",
      "mailer-daemon@acme.com",
    ]
  ) {
    const r = checkAddress(bad);
    assert(!r.ok, bad);
    if (!r.ok) assertEquals(r.code, "role_or_test", bad);
  }
  for (const ok of ["info@acme.com", "sales@acme.com", "hello@acme.com", "tester.jones@acme.com"]) {
    // tester.jones is a person, not the "tester" system mailbox.
    assert(checkAddress(ok).ok, ok);
  }
});

Deno.test("hygiene: reserved domains are refused", () => {
  const r = checkAddress("pat@example.com");
  assert(!r.ok);
  if (!r.ok) assertEquals(r.code, "reserved_domain");
  assert(!checkAddress("pat@foo.test").ok);
});

Deno.test("mx: a domain with no MX is reported; errors and timeouts are not", async () => {
  const resolver = (d: string): Promise<unknown[]> => {
    if (d === "nomail.org") return Promise.resolve([]);
    if (d === "gone.org") return Promise.reject(new Deno.errors.NotFound("nxdomain"));
    if (d === "flaky.org") return Promise.reject(new Error("SERVFAIL"));
    if (d === "slow.org") return new Promise((r) => setTimeout(() => r([]), 200));
    return Promise.resolve([{ exchange: "mx.example", preference: 10 }]);
  };
  const noMx = await checkDomainsHaveMx(
    ["gmail.com", "nomail.org", "gone.org", "flaky.org", "slow.org"],
    { resolver, timeoutMs: 20 },
  );
  assertEquals([...noMx].sort(), ["gone.org", "nomail.org"]);
});

Deno.test("mx: bounded to the most common distinct domains", async () => {
  const seen: string[] = [];
  const resolver = (d: string) => {
    seen.push(d);
    return Promise.resolve([] as unknown[]);
  };
  await checkDomainsHaveMx(["a.org", "b.org", "b.org", "c.org", "c.org", "c.org"], {
    resolver,
    maxDomains: 2,
  });
  assertEquals(seen.sort(), ["b.org", "c.org"]);
});
