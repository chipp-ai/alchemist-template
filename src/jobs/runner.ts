/**
 * In-process job runner.
 *
 * One loop per replica, ticking every JOBS_TICK_MS (default 30 s). Each
 * tick runs due scheduled jobs (which typically enqueue email) and then
 * delivers due outbox rows, so a digest that fires this tick also leaves
 * this tick. Row claims use FOR UPDATE SKIP LOCKED, so running the loop
 * on every replica is safe; there is no leader.
 *
 * Why not Deno.cron: its schedules are static (registered in code, not
 * per-organization rows) and, outside Deno Deploy, every replica fires
 * independently. Why not Redis: the platform already claims queue rows
 * with SKIP LOCKED, and a second queueing substrate isn't justified.
 *
 * Started from main.ts when JOBS_ENABLED is not "0"/"false". Never
 * started by tests (they import app.ts, not main.ts) or by the migration
 * entrypoint. `runJobsTick` is exported for the dev tick route so an
 * agent can drive the clock instead of waiting.
 */

import { isTransientDbError } from "@/db/client.ts";
import { log } from "@/lib/logger.ts";
import { deliverDueEmails, type DeliverDueResult } from "@/services/email-outbox.service.ts";
import { type RunDueResult, runDueScheduledJobs } from "@/services/scheduled-jobs.service.ts";

export const DEFAULT_TICK_MS = 30_000;

export interface TickOptions {
  /** Wall clock for the tick. Injected by the dev route for time travel. */
  now?: Date;
}

export interface TickResult {
  now: string;
  jobs: RunDueResult;
  emails: DeliverDueResult;
  durationMs: number;
}

export function jobsEnabled(): boolean {
  const v = (Deno.env.get("JOBS_ENABLED") ?? "1").toLowerCase();
  return v !== "0" && v !== "false";
}

export function tickIntervalMs(): number {
  const v = Number(Deno.env.get("JOBS_TICK_MS"));
  return Number.isFinite(v) && v >= 1000 ? v : DEFAULT_TICK_MS;
}

/** One pass: scheduled jobs, then outbox delivery. */
export async function runJobsTick(opts: TickOptions = {}): Promise<TickResult> {
  const now = opts.now ?? new Date();
  const startedAt = performance.now();
  const jobs = await runDueScheduledJobs({ now });
  const emails = await deliverDueEmails({ now });
  return {
    now: now.toISOString(),
    jobs,
    emails,
    durationMs: Math.round(performance.now() - startedAt),
  };
}

let timer: ReturnType<typeof setTimeout> | null = null;
let running = false;
let ticking: Promise<void> | null = null;

async function tickOnce(): Promise<void> {
  try {
    const r = await runJobsTick();
    if (r.jobs.claimed > 0 || r.emails.claimed > 0) {
      log.info("Job runner tick", { source: "jobs", ...flatten(r) });
    }
  } catch (err) {
    const emit = isTransientDbError(err) ? log.warn : log.error;
    emit("Job runner tick failed", { source: "jobs" }, err);
  }
}

function flatten(r: TickResult): Record<string, unknown> {
  return {
    jobsClaimed: r.jobs.claimed,
    jobsOk: r.jobs.ok,
    jobsFailed: r.jobs.failed,
    emailsClaimed: r.emails.claimed,
    emailsSent: r.emails.sent,
    emailsRetried: r.emails.retried,
    emailsFailed: r.emails.failed,
    durationMs: r.durationMs,
  };
}

function schedule(delayMs: number): void {
  if (!running) return;
  timer = setTimeout(async () => {
    timer = null;
    ticking = tickOnce();
    await ticking;
    ticking = null;
    schedule(tickIntervalMs());
  }, delayMs);
}

/** Idempotent. The first tick runs after one interval, not immediately. */
export function startJobRunner(opts: { initialDelayMs?: number } = {}): void {
  if (running) return;
  running = true;
  log.info("Job runner started", { source: "jobs", tickMs: tickIntervalMs() });
  schedule(opts.initialDelayMs ?? tickIntervalMs());
}

/** Stops scheduling and waits for an in-flight tick to finish. */
export async function stopJobRunner(): Promise<void> {
  if (!running) return;
  running = false;
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  if (ticking) await ticking;
  log.info("Job runner stopped", { source: "jobs" });
}

export function isJobRunnerRunning(): boolean {
  return running;
}
