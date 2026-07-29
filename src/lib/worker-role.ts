/**
 * WORKER_ROLE -- which half of a split deployment is this process?
 *
 * The Alchemist platform can run an app as TWO pods from the SAME image when
 * the project declares a `worker:` block in `.alchemist/deployment.yaml`:
 *
 *   - the pod serving traffic gets `WORKER_ROLE=api`
 *   - a sibling pod gets `WORKER_ROLE=worker`
 *
 * Background work (periodic loops, queue drains, boot-time reindexing) must
 * run in EXACTLY ONE of them, or every tick happens twice.
 *
 * ## The default is "run everything", deliberately
 *
 * An ABSENT or unrecognized `WORKER_ROLE` resolves to `"all"`, which runs
 * background work. That fail-OPEN default is the important half of the
 * contract: a project that has NOT declared a worker runs a single pod with no
 * `WORKER_ROLE` set at all, and it must keep doing its background work. If
 * this defaulted to `"api"` instead, simply deploying without a worker would
 * silently stop every periodic loop -- the failure mode is invisible, because
 * nothing errors, work just quietly stops happening.
 *
 * ## Why gating matters even though the loops are idempotent
 *
 * The inbound-email reaper claims rows safely, so a duplicate claim does not
 * corrupt anything -- it "only wastes LLM spend" (its own words). That is
 * still real money per tick, per pod, forever. `reindexDocs()` re-embeds
 * changed chunks at boot, so a second pod pays for the same embeddings again.
 *
 * ## HTTP is NOT gated
 *
 * Both roles serve HTTP. The platform gives the worker pod its own readiness
 * probe, and probe traffic is what proves the pod healthy -- a worker that
 * refused to serve `/health` would never become Ready. Only BACKGROUND work is
 * role-gated.
 *
 * Mirrors the platform's own `CHIPP_ROLE` helper, including the fail-open
 * default. Keep the semantics identical so the two are not surprising in
 * different ways.
 */

export type WorkerRole = "all" | "api" | "worker";

/** Raw env value, for logging what was actually seen (including a typo). */
export function rawWorkerRoleEnv(): string | undefined {
  return Deno.env.get("WORKER_ROLE") ?? undefined;
}

/**
 * Resolved role. Anything not exactly `api` or `worker` -- absent, empty, a
 * typo, mixed case beyond a trim/lowercase -- resolves to `"all"` so
 * background work keeps running rather than silently stopping.
 */
export function getWorkerRole(): WorkerRole {
  const raw = rawWorkerRoleEnv()?.trim().toLowerCase();
  if (raw === "api") return "api";
  if (raw === "worker") return "worker";
  return "all";
}

/**
 * Should THIS process run background work (periodic loops, queue drains,
 * boot-time reindex)?
 *
 * True for `worker` and for the single-pod `all` default; false ONLY for a pod
 * explicitly marked `api`, which by definition has a worker sibling.
 */
export function roleRunsBackgroundWork(): boolean {
  return getWorkerRole() !== "api";
}
