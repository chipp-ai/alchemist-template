/**
 * Scheduled jobs — recurring work on a cron, executed by the job runner.
 *
 * A `scheduled_jobs` row = (kind, cron, timezone, payload, org scope).
 * `kind` names a handler registered with defineJob() in src/jobs/. The
 * runner claims due rows (FOR UPDATE SKIP LOCKED, so multi-replica safe),
 * invokes the handler with a JobContext, records the run in job_history,
 * and advances next_run_at.
 *
 * Catch-up policy: next_run_at is computed from the wall clock at run
 * time, not from the missed fire time. A job that was due 40 times while
 * the app was down runs ONCE when it comes back, then resumes its cadence.
 * Digests and reminders want exactly that; a job that must account for
 * every missed window should track its own cursor in `payload`.
 */

import { db } from "@/db/client.ts";
import type { Database, ScheduledJob, ScheduledJobUpdate } from "@/db/schema.ts";
import type { Kysely } from "kysely";
import { log } from "@/lib/logger.ts";
import { BadRequestError, NotFoundError } from "@/utils/errors.ts";
import {
  assertValidCron,
  assertValidTimezone,
  nextRunAfter,
  shortestIntervalSeconds,
} from "@/jobs/cron.ts";
import { getJobHandler, isJobKindRegistered, type JobContext } from "@/jobs/registry.ts";
import { enqueueEmail } from "@/services/email-outbox.service.ts";

export type { ScheduledJob };

/** Tightest cadence a schedule may have. Override with JOBS_MIN_INTERVAL_SECONDS. */
export const MIN_INTERVAL_SECONDS = Number(Deno.env.get("JOBS_MIN_INTERVAL_SECONDS")) || 300;

/** A handler that runs longer than this is abandoned and the run marked failed. */
export const HANDLER_TIMEOUT_MS = Number(Deno.env.get("JOBS_HANDLER_TIMEOUT_MS")) || 60_000;

/** A row locked longer than this is treated as orphaned and re-claimable. */
export const STALE_JOB_LOCK_MS = 15 * 60 * 1000;

// ── CRUD ────────────────────────────────────────────────────────────────

export interface CreateScheduledJobInput {
  kind: string;
  cron: string;
  timezone?: string;
  payload?: Record<string, unknown>;
  organizationId?: string | null;
  enabled?: boolean;
  /** Wall clock used to seed next_run_at. Injected for tests. */
  now?: Date;
}

function validateSchedule(kind: string, cron: string, timezone: string, now: Date): Date {
  if (!isJobKindRegistered(kind)) {
    throw new BadRequestError(
      `No job handler registered for kind "${kind}". Register one with defineJob() in src/jobs/.`,
    );
  }
  assertValidCron(cron);
  assertValidTimezone(timezone);
  const interval = shortestIntervalSeconds(cron, timezone, now);
  if (interval !== null && interval < MIN_INTERVAL_SECONDS) {
    throw new BadRequestError(
      `Schedule fires every ${interval}s; the minimum is ${MIN_INTERVAL_SECONDS}s.`,
    );
  }
  const next = nextRunAfter(cron, timezone, now);
  if (!next) throw new BadRequestError(`Cron "${cron}" never fires after ${now.toISOString()}`);
  return next;
}

export async function createScheduledJob(
  input: CreateScheduledJobInput,
  executor: Kysely<Database> = db,
): Promise<ScheduledJob> {
  const now = input.now ?? new Date();
  const timezone = input.timezone?.trim() || "UTC";
  const nextRunAt = validateSchedule(input.kind, input.cron.trim(), timezone, now);
  return await executor
    .insertInto("scheduled_jobs")
    .values({
      kind: input.kind,
      cron: input.cron.trim(),
      timezone,
      payload: input.payload ?? {},
      organizationId: input.organizationId ?? null,
      enabled: input.enabled ?? true,
      nextRunAt,
    })
    .returningAll()
    .executeTakeFirstOrThrow();
}

export interface UpdateScheduledJobInput {
  cron?: string;
  timezone?: string;
  payload?: Record<string, unknown>;
  enabled?: boolean;
  now?: Date;
}

export async function updateScheduledJob(
  id: string,
  patch: UpdateScheduledJobInput,
): Promise<ScheduledJob> {
  const current = await getScheduledJob(id);
  if (!current) throw new NotFoundError("Scheduled job", id);
  const now = patch.now ?? new Date();
  const cron = patch.cron?.trim() ?? current.cron;
  const timezone = patch.timezone?.trim() ?? current.timezone;
  const enabled = patch.enabled ?? current.enabled;

  const cadenceChanged = cron !== current.cron || timezone !== current.timezone;
  const reEnabled = enabled && !current.enabled;
  const set: ScheduledJobUpdate = {};
  if (patch.cron !== undefined) set.cron = cron;
  if (patch.timezone !== undefined) set.timezone = timezone;
  if (patch.payload !== undefined) set.payload = patch.payload;
  if (patch.enabled !== undefined) set.enabled = enabled;
  if (cadenceChanged || reEnabled) {
    set.nextRunAt = validateSchedule(current.kind, cron, timezone, now);
  }
  if (Object.keys(set).length === 0) return current;

  return await db
    .updateTable("scheduled_jobs")
    .set(set)
    .where("id", "=", id)
    .returningAll()
    .executeTakeFirstOrThrow();
}

export async function deleteScheduledJob(id: string): Promise<boolean> {
  const res = await db.deleteFrom("scheduled_jobs").where("id", "=", id).executeTakeFirst();
  return Number(res.numDeletedRows) > 0;
}

export async function getScheduledJob(id: string): Promise<ScheduledJob | undefined> {
  return await db.selectFrom("scheduled_jobs").selectAll().where("id", "=", id).executeTakeFirst();
}

export interface ListScheduledJobsOptions {
  /** Filter to one org; `null` lists app-global jobs; omit for everything. */
  organizationId?: string | null;
  limit?: number;
}

export async function listScheduledJobs(
  opts: ListScheduledJobsOptions = {},
): Promise<ScheduledJob[]> {
  const limit = Math.min(Math.max(opts.limit ?? 100, 1), 500);
  let q = db.selectFrom("scheduled_jobs").selectAll().orderBy("nextRunAt", "asc").limit(limit);
  if (opts.organizationId !== undefined) {
    q = opts.organizationId === null
      ? q.where("organizationId", "is", null)
      : q.where("organizationId", "=", opts.organizationId);
  }
  return await q.execute();
}

// ── Execution ───────────────────────────────────────────────────────────

export interface RunDueOptions {
  now?: Date;
  limit?: number;
}

export interface RunDueResult {
  claimed: number;
  ok: number;
  failed: number;
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Claim and execute every due schedule. One job_history row per run.
 * Never throws for a handler failure; a DB failure while claiming does
 * propagate so the runner can log it once.
 */
export async function runDueScheduledJobs(opts: RunDueOptions = {}): Promise<RunDueResult> {
  const now = opts.now ?? new Date();
  const limit = Math.min(Math.max(opts.limit ?? 20, 1), 200);
  const staleBefore = new Date(now.getTime() - STALE_JOB_LOCK_MS);
  const result: RunDueResult = { claimed: 0, ok: 0, failed: 0 };

  const claimed = await db.transaction().execute(async (trx) => {
    const rows = await trx
      .selectFrom("scheduled_jobs")
      .selectAll()
      .where("enabled", "=", true)
      .where("nextRunAt", "<=", now)
      .where((eb) => eb.or([eb("lockedAt", "is", null), eb("lockedAt", "<", staleBefore)]))
      .orderBy("nextRunAt", "asc")
      .limit(limit)
      .forUpdate()
      .skipLocked()
      .execute();
    if (rows.length === 0) return [];
    await trx
      .updateTable("scheduled_jobs")
      .set({ lockedAt: now })
      .where("id", "in", rows.map((r) => r.id))
      .execute();
    return rows;
  });

  result.claimed = claimed.length;

  for (const job of claimed) {
    const outcome = await executeOne(job, now);
    if (outcome === "ok") result.ok++;
    else result.failed++;
  }
  return result;
}

async function executeOne(job: ScheduledJob, now: Date): Promise<"ok" | "failed"> {
  const scheduledFor = job.nextRunAt;
  const history = await db
    .insertInto("job_history")
    .values({
      jobType: job.kind,
      organizationId: job.organizationId,
      status: "running",
      payload: { scheduledJobId: job.id, scheduledFor: scheduledFor.toISOString(), ...job.payload },
      startedAt: now,
    })
    .returning("id")
    .executeTakeFirstOrThrow();

  const ctx: JobContext = {
    job,
    payload: job.payload ?? {},
    organizationId: job.organizationId,
    scheduledFor,
    now,
    idempotencyKey: (suffix) => `job:${job.kind}:${job.id}:${scheduledFor.toISOString()}:${suffix}`,
    enqueueEmail: (input) =>
      enqueueEmail({
        organizationId: job.organizationId,
        source: `job:${job.kind}`,
        ...input,
      }),
  };

  let status: "ok" | "failed" = "ok";
  let error: string | null = null;
  let resultPayload: Record<string, unknown> | null = null;

  const handler = getJobHandler(job.kind);
  if (!handler) {
    status = "failed";
    error = `No job handler registered for kind "${job.kind}"`;
    log.error("Scheduled job has no handler", { source: "jobs", kind: job.kind, jobId: job.id });
  } else {
    try {
      const out = await withTimeout(handler(ctx), HANDLER_TIMEOUT_MS, `job ${job.kind}`);
      resultPayload = out ? { ...out } : null;
      log.info("Scheduled job ran", {
        source: "jobs",
        kind: job.kind,
        jobId: job.id,
        organizationId: job.organizationId,
        summary: out?.summary ?? null,
      });
    } catch (err) {
      status = "failed";
      error = err instanceof Error ? err.message : String(err);
      log.error("Scheduled job failed", {
        source: "jobs",
        kind: job.kind,
        jobId: job.id,
        organizationId: job.organizationId,
      }, err);
    }
  }

  const completedAt = new Date();
  let nextRunAt: Date | null = null;
  try {
    // Advance from the tick clock (`now`), not the wall clock: `now` is
    // >= the fire time being serviced, so the next fire is strictly
    // later, and an injected clock (tests, dev tick) stays consistent.
    nextRunAt = nextRunAfter(job.cron, job.timezone, now);
  } catch (err) {
    // Cron/timezone were validated on write; reaching here means the
    // runtime lost the zone or the row was edited by hand. Disable
    // rather than spin.
    status = "failed";
    error = `${error ? error + "; " : ""}cannot compute next run: ${
      err instanceof Error ? err.message : String(err)
    }`;
  }

  await db
    .updateTable("job_history")
    .set({
      status: status === "ok" ? "completed" : "failed",
      result: resultPayload,
      error,
      completedAt,
    })
    .where("id", "=", history.id)
    .execute();

  await db
    .updateTable("scheduled_jobs")
    .set({
      lastRunAt: now,
      lastStatus: status,
      lastError: error,
      lockedAt: null,
      ...(nextRunAt ? { nextRunAt } : { enabled: false }),
    })
    .where("id", "=", job.id)
    .execute();

  return status;
}
