/**
 * Scheduled-job handler registry.
 *
 * A `scheduled_jobs` row names a `kind`; this module maps kinds to the
 * function that runs them. Register a handler once at module load:
 *
 *   // src/jobs/handlers/weekly-report.ts
 *   import { defineJob } from "@/jobs/registry.ts";
 *
 *   defineJob("weekly_report", async (ctx) => {
 *     const rows = await db.selectFrom("orders")...;
 *     await ctx.enqueueEmail({
 *       to: owner.email,
 *       subject: "Your week in numbers",
 *       text: ...,
 *       idempotencyKey: ctx.idempotencyKey(owner.id),
 *     });
 *     return { summary: `emailed ${n} owners` };
 *   }, { description: "Monday-morning order summary to each org owner" });
 *
 * then import the file from `src/jobs/index.ts` so the registration runs
 * at boot (same pattern as store registration in web/src/main.ts).
 *
 * The handler contract:
 *   - It runs on ONE replica per due tick (the row is claimed with
 *     SKIP LOCKED) but may run again if it crashed mid-way and the lock
 *     went stale. Make it idempotent: every enqueueEmail gets an
 *     idempotencyKey built from ctx.idempotencyKey(...).
 *   - It must finish within JOBS_HANDLER_TIMEOUT_MS (default 60 s). Do
 *     the heavy lifting by enqueueing work, not by doing it inline.
 *   - Throwing marks the run failed (recorded in job_history, surfaced in
 *     scheduled_jobs.last_error) and the schedule still advances.
 */

import type { ScheduledJob } from "@/db/schema.ts";
import type { EmailOutboxRow, EnqueueEmailInput } from "@/services/email-outbox.service.ts";

export interface JobContext {
  /** The scheduled_jobs row being executed. */
  job: ScheduledJob;
  /** `job.payload`, typed loosely; validate what you read. */
  payload: Record<string, unknown>;
  /** Org scope of the row, or null for an app-global job. */
  organizationId: string | null;
  /** The fire time this run is servicing (the row's next_run_at when claimed). */
  scheduledFor: Date;
  /** Wall clock at claim time. Injected so tests can time-travel. */
  now: Date;
  /**
   * Queue an email. `organizationId` and `source` default to the job's;
   * pass an explicit `idempotencyKey` (use `ctx.idempotencyKey`) so a
   * re-run never double-sends.
   */
  enqueueEmail: (input: EnqueueEmailInput) => Promise<{ row: EmailOutboxRow; created: boolean }>;
  /**
   * Build an idempotency key unique to this job + this fire time + your
   * suffix (typically the recipient id). Two runs servicing the same
   * fire time produce the same key, so the second enqueue is a no-op.
   */
  idempotencyKey: (suffix: string) => string;
}

export interface JobResult {
  /** One line for job_history.result and the dev panel. */
  summary?: string;
  [key: string]: unknown;
}

export type JobHandler = (ctx: JobContext) => Promise<JobResult | void>;

interface JobDefinition {
  kind: string;
  handler: JobHandler;
  description: string;
}

const REGISTRY = new Map<string, JobDefinition>();

const KIND_RE = /^[a-z][a-z0-9_]{1,63}$/;

/**
 * Register a handler for `kind`. Kinds are snake_case identifiers; a
 * second registration for the same kind throws so a copy-paste never
 * silently replaces a handler.
 */
export function defineJob(
  kind: string,
  handler: JobHandler,
  opts: { description?: string } = {},
): void {
  if (!KIND_RE.test(kind)) {
    throw new Error(`defineJob: kind "${kind}" must match ${KIND_RE}`);
  }
  if (REGISTRY.has(kind)) {
    throw new Error(`defineJob: kind "${kind}" is already registered`);
  }
  REGISTRY.set(kind, { kind, handler, description: opts.description ?? "" });
}

export function getJobHandler(kind: string): JobHandler | undefined {
  return REGISTRY.get(kind)?.handler;
}

export function isJobKindRegistered(kind: string): boolean {
  return REGISTRY.has(kind);
}

export function listJobKinds(): Array<{ kind: string; description: string }> {
  return [...REGISTRY.values()].map(({ kind, description }) => ({ kind, description }));
}

/** Test-only: drop a registration so a test file can re-define it. */
export function __unregisterJobForTests(kind: string): void {
  REGISTRY.delete(kind);
}
