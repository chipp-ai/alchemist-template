/**
 * Scheduled jobs — CRUD validation, claiming, execution, history, and
 * idempotent email fan-out from a handler.
 *
 * A test handler `test_echo` is registered once per file. It records the
 * contexts it received and, when payload.emailTo is set, enqueues one
 * email keyed on ctx.idempotencyKey so a re-run of the same fire time
 * cannot double-send.
 */

import { assert, assertEquals, assertRejects } from "@std/assert";
import { createIsolatedUser, getTestDb } from "../helpers.ts";
import { defineJob, isJobKindRegistered, type JobContext } from "@/jobs/registry.ts";
import { nextRunAfter } from "@/jobs/cron.ts";
import {
  createScheduledJob,
  deleteScheduledJob,
  getScheduledJob,
  listScheduledJobs,
  runDueScheduledJobs,
  updateScheduledJob,
} from "@/services/scheduled-jobs.service.ts";
import { listOutbox } from "@/services/email-outbox.service.ts";
import { BadRequestError } from "@/utils/errors.ts";

const db = getTestDb();

const received: JobContext[] = [];
let failNext = false;

if (!isJobKindRegistered("test_echo")) {
  defineJob("test_echo", async (ctx) => {
    received.push(ctx);
    if (failNext) {
      failNext = false;
      throw new Error("handler exploded");
    }
    const to = typeof ctx.payload.emailTo === "string" ? ctx.payload.emailTo : null;
    if (to) {
      await ctx.enqueueEmail({
        to,
        subject: "Echo",
        text: "echo",
        idempotencyKey: ctx.idempotencyKey("recipient"),
      });
    }
    return { summary: `echoed ${ctx.job.kind}` };
  }, { description: "test handler" });
}

async function cleanupHistory(orgId: string): Promise<void> {
  await db.deleteFrom("job_history").where("organizationId", "=", orgId).execute();
}

const NOW = new Date("2026-09-22T12:00:00Z");

Deno.test("jobs: create validates kind, cron, timezone and minimum interval", async () => {
  const { org, cleanup } = await createIsolatedUser("owner");
  try {
    await assertRejects(
      () => createScheduledJob({ kind: "nope", cron: "0 9 * * 1", organizationId: org.id }),
      BadRequestError,
      "No job handler registered",
    );
    await assertRejects(
      () => createScheduledJob({ kind: "test_echo", cron: "sometimes", organizationId: org.id }),
      BadRequestError,
      "Invalid cron",
    );
    await assertRejects(
      () =>
        createScheduledJob({
          kind: "test_echo",
          cron: "0 9 * * 1",
          timezone: "Mars/Olympus",
          organizationId: org.id,
        }),
      BadRequestError,
      "Unknown timezone",
    );
    await assertRejects(
      () => createScheduledJob({ kind: "test_echo", cron: "* * * * *", organizationId: org.id }),
      BadRequestError,
      "minimum",
    );

    const job = await createScheduledJob({
      kind: "test_echo",
      cron: "0 9 * * 1",
      timezone: "America/New_York",
      organizationId: org.id,
      payload: { hello: "world" },
      now: NOW,
    });
    assertEquals(job.enabled, true);
    assertEquals(job.timezone, "America/New_York");
    assertEquals(job.payload, { hello: "world" });
    assertEquals(job.nextRunAt.toISOString(), "2026-09-28T13:00:00.000Z");
    assertEquals(
      job.nextRunAt.getTime(),
      nextRunAfter("0 9 * * 1", "America/New_York", NOW)!.getTime(),
    );
  } finally {
    await cleanup();
  }
});

Deno.test("jobs: a due job runs once, records history, and advances", async () => {
  const { org, cleanup } = await createIsolatedUser("owner");
  received.length = 0;
  try {
    const job = await createScheduledJob({
      kind: "test_echo",
      cron: "0 9 * * 1",
      timezone: "UTC",
      organizationId: org.id,
      payload: { hello: "world" },
      now: NOW,
    });
    const fireAt = job.nextRunAt; // 2026-09-28T09:00Z
    const tickAt = new Date(fireAt.getTime() + 30_000);

    const notYet = await runDueScheduledJobs({ now: NOW });
    assertEquals(notYet.claimed, 0);

    const ran = await runDueScheduledJobs({ now: tickAt });
    assertEquals(ran, { claimed: 1, ok: 1, failed: 0 });
    assertEquals(received.length, 1);
    assertEquals(received[0].organizationId, org.id);
    assertEquals(received[0].payload, { hello: "world" });
    assertEquals(received[0].scheduledFor.getTime(), fireAt.getTime());
    assertEquals(received[0].now.getTime(), tickAt.getTime());

    const after = (await getScheduledJob(job.id))!;
    assertEquals(after.lastStatus, "ok");
    assertEquals(after.lastError, null);
    assertEquals(after.lastRunAt!.getTime(), tickAt.getTime());
    assertEquals(after.lockedAt, null);
    assert(after.nextRunAt.getTime() > tickAt.getTime());
    assertEquals(after.nextRunAt.toISOString(), "2026-10-05T09:00:00.000Z");

    const history = await db
      .selectFrom("job_history")
      .selectAll()
      .where("organizationId", "=", org.id)
      .execute();
    assertEquals(history.length, 1);
    assertEquals(history[0].jobType, "test_echo");
    assertEquals(history[0].status, "completed");
    assertEquals(history[0].result, { summary: "echoed test_echo" });
    assertEquals(
      (history[0].payload as Record<string, unknown>).scheduledJobId,
      job.id,
    );

    // Same clock again: already advanced, nothing due.
    const again = await runDueScheduledJobs({ now: tickAt });
    assertEquals(again.claimed, 0);
  } finally {
    await cleanupHistory(org.id);
    await cleanup();
  }
});

Deno.test("jobs: a throwing handler is recorded as failed and still advances", async () => {
  const { org, cleanup } = await createIsolatedUser("owner");
  try {
    const job = await createScheduledJob({
      kind: "test_echo",
      cron: "0 9 * * 1",
      organizationId: org.id,
      now: NOW,
    });
    failNext = true;
    const ran = await runDueScheduledJobs({ now: new Date(job.nextRunAt.getTime() + 1000) });
    assertEquals(ran, { claimed: 1, ok: 0, failed: 1 });

    const after = (await getScheduledJob(job.id))!;
    assertEquals(after.lastStatus, "failed");
    assertEquals(after.lastError, "handler exploded");
    assertEquals(after.enabled, true);
    assert(after.nextRunAt.getTime() > job.nextRunAt.getTime());

    const history = await db
      .selectFrom("job_history")
      .select(["status", "error"])
      .where("organizationId", "=", org.id)
      .executeTakeFirstOrThrow();
    assertEquals(history.status, "failed");
    assertEquals(history.error, "handler exploded");
  } finally {
    failNext = false;
    await cleanupHistory(org.id);
    await cleanup();
  }
});

Deno.test("jobs: disabled jobs are never claimed", async () => {
  const { org, cleanup } = await createIsolatedUser("owner");
  try {
    const job = await createScheduledJob({
      kind: "test_echo",
      cron: "0 9 * * 1",
      organizationId: org.id,
      enabled: false,
      now: NOW,
    });
    const ran = await runDueScheduledJobs({ now: new Date(job.nextRunAt.getTime() + 1000) });
    assertEquals(ran.claimed, 0);
  } finally {
    await cleanup();
  }
});

Deno.test("jobs: handler email fan-out is idempotent across a re-run of the same fire time", async () => {
  const { org, user, cleanup } = await createIsolatedUser("owner");
  try {
    const job = await createScheduledJob({
      kind: "test_echo",
      cron: "0 9 * * 1",
      organizationId: org.id,
      payload: { emailTo: user.email },
      now: NOW,
    });
    const tickAt = new Date(job.nextRunAt.getTime() + 1000);
    await runDueScheduledJobs({ now: tickAt });

    let rows = await listOutbox({ organizationId: org.id });
    assertEquals(rows.length, 1);
    assertEquals(rows[0].source, "job:test_echo");
    assertEquals(rows[0].toEmail, user.email);
    assert(rows[0].idempotencyKey!.startsWith(`job:test_echo:${job.id}:`));

    // Simulate the stale-lock re-run case: reset next_run_at to the same
    // fire time and run again. The handler runs, but its enqueue dedupes.
    await db
      .updateTable("scheduled_jobs")
      .set({ nextRunAt: job.nextRunAt })
      .where("id", "=", job.id)
      .execute();
    const rerun = await runDueScheduledJobs({ now: tickAt });
    assertEquals(rerun.ok, 1);
    rows = await listOutbox({ organizationId: org.id });
    assertEquals(rows.length, 1);
  } finally {
    await cleanupHistory(org.id);
    await cleanup();
  }
});

Deno.test("jobs: update recomputes next_run_at on cadence change and re-enable", async () => {
  const { org, cleanup } = await createIsolatedUser("owner");
  try {
    const job = await createScheduledJob({
      kind: "test_echo",
      cron: "0 9 * * 1",
      organizationId: org.id,
      now: NOW,
    });
    const moved = await updateScheduledJob(job.id, { cron: "0 9 * * 3", now: NOW });
    assertEquals(moved.cron, "0 9 * * 3");
    assertEquals(moved.nextRunAt.toISOString(), "2026-09-23T09:00:00.000Z");

    const payloadOnly = await updateScheduledJob(job.id, { payload: { a: 1 }, now: NOW });
    assertEquals(payloadOnly.payload, { a: 1 });
    assertEquals(payloadOnly.nextRunAt.getTime(), moved.nextRunAt.getTime());

    const disabled = await updateScheduledJob(job.id, { enabled: false, now: NOW });
    assertEquals(disabled.enabled, false);
    const later = new Date("2026-10-01T00:00:00Z");
    const enabled = await updateScheduledJob(job.id, { enabled: true, now: later });
    assertEquals(enabled.nextRunAt.toISOString(), "2026-10-07T09:00:00.000Z");

    await assertRejects(
      () => updateScheduledJob(job.id, { cron: "* * * * *" }),
      BadRequestError,
    );
  } finally {
    await cleanup();
  }
});

Deno.test("jobs: list scopes by org and delete removes the row", async () => {
  const { org, cleanup } = await createIsolatedUser("owner");
  try {
    const job = await createScheduledJob({
      kind: "test_echo",
      cron: "0 9 * * 1",
      organizationId: org.id,
      now: NOW,
    });
    const mine = await listScheduledJobs({ organizationId: org.id });
    assertEquals(mine.map((j) => j.id), [job.id]);

    assert(await deleteScheduledJob(job.id));
    assert(!(await deleteScheduledJob(job.id)));
    assertEquals((await listScheduledJobs({ organizationId: org.id })).length, 0);
  } finally {
    await cleanup();
  }
});
