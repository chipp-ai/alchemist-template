/**
 * Cron helpers for scheduled jobs.
 *
 * Thin wrapper over `croner` so the rest of the codebase never touches the
 * library directly. Schedules are standard 5-field cron expressions
 * evaluated in an IANA timezone, which is what customers mean by "every
 * Monday at 9am": 9am in THEIR zone, DST included.
 *
 *   "0 9 * * 1"      Mondays 09:00
 *   "0 8 1 * *"      1st of the month 08:00
 *   "*\/15 * * * *"  every 15 minutes
 *
 * `croner` also accepts a 6-field form with leading seconds; we allow it
 * but the minimum interval guard in scheduled-jobs.service.ts keeps
 * sub-minute schedules out.
 */

import { Cron } from "croner";
import { BadRequestError } from "@/utils/errors.ts";

/** Throws BadRequestError when `expr` is not a cron expression croner accepts. */
export function assertValidCron(expr: string): void {
  try {
    new Cron(expr, { timezone: "UTC" });
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new BadRequestError(`Invalid cron expression "${expr}": ${reason}`);
  }
}

/** True when `tz` is an IANA zone the runtime knows (e.g. "America/Chicago"). */
export function isValidTimezone(tz: string): boolean {
  if (!tz) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export function assertValidTimezone(tz: string): void {
  if (!isValidTimezone(tz)) {
    throw new BadRequestError(
      `Unknown timezone "${tz}". Use an IANA name like "America/New_York".`,
    );
  }
}

/**
 * The first fire time strictly after `after`, or null when the expression
 * never fires again (e.g. a one-shot date already in the past).
 */
export function nextRunAfter(expr: string, tz: string, after: Date): Date | null {
  const pattern = new Cron(expr, { timezone: tz });
  return pattern.nextRun(after) ?? null;
}

/**
 * Seconds between the first two fires after `after`. Used to enforce a
 * minimum interval so a typo like "* * * * *" doesn't enqueue a mail a
 * minute. Returns null when the schedule fires fewer than twice.
 */
export function shortestIntervalSeconds(expr: string, tz: string, after: Date): number | null {
  const pattern = new Cron(expr, { timezone: tz });
  const runs = pattern.nextRuns(2, after);
  if (runs.length < 2) return null;
  return Math.round((runs[1].getTime() - runs[0].getTime()) / 1000);
}
