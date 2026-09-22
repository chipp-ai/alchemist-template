/**
 * Cron helpers — pure, no DB.
 */

import { assert, assertEquals, assertThrows } from "@std/assert";
import {
  assertValidCron,
  assertValidTimezone,
  isValidTimezone,
  nextRunAfter,
  shortestIntervalSeconds,
} from "@/jobs/cron.ts";
import { BadRequestError } from "@/utils/errors.ts";

// Tuesday 2026-09-22 12:00 UTC. Next Monday is 2026-09-28.
const TUESDAY_NOON_UTC = new Date("2026-09-22T12:00:00Z");

Deno.test("cron: Monday 09:00 in New York resolves to 13:00 UTC during EDT", () => {
  const next = nextRunAfter("0 9 * * 1", "America/New_York", TUESDAY_NOON_UTC);
  assertEquals(next?.toISOString(), "2026-09-28T13:00:00.000Z");
});

Deno.test("cron: the same wall-clock hour shifts with the zone", () => {
  const ny = nextRunAfter("0 9 * * 1", "America/New_York", TUESDAY_NOON_UTC)!;
  const la = nextRunAfter("0 9 * * 1", "America/Los_Angeles", TUESDAY_NOON_UTC)!;
  assertEquals(la.getTime() - ny.getTime(), 3 * 60 * 60 * 1000);
});

Deno.test("cron: next run is strictly after `after`", () => {
  const exactlyOnFire = new Date("2026-09-28T13:00:00Z");
  const next = nextRunAfter("0 9 * * 1", "America/New_York", exactlyOnFire)!;
  assert(next.getTime() > exactlyOnFire.getTime());
  assertEquals(next.toISOString(), "2026-10-05T13:00:00.000Z");
});

Deno.test("cron: shortest interval detects every-15-minutes", () => {
  assertEquals(shortestIntervalSeconds("*/15 * * * *", "UTC", TUESDAY_NOON_UTC), 900);
  assertEquals(shortestIntervalSeconds("* * * * *", "UTC", TUESDAY_NOON_UTC), 60);
});

Deno.test("cron: invalid expression throws BadRequestError", () => {
  assertThrows(() => assertValidCron("every monday"), BadRequestError);
  assertThrows(() => assertValidCron("99 99 * * *"), BadRequestError);
  assertValidCron("0 9 * * 1");
});

Deno.test("timezone: IANA names validate, garbage does not", () => {
  assert(isValidTimezone("UTC"));
  assert(isValidTimezone("America/Chicago"));
  assert(!isValidTimezone("Mars/Olympus"));
  assert(!isValidTimezone(""));
  assertThrows(() => assertValidTimezone("Mars/Olympus"), BadRequestError);
});
