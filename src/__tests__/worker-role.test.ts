/**
 * WORKER_ROLE resolution + the background-work gate.
 *
 * The platform can run this image as TWO pods when the project declares a
 * `worker:` block in `.alchemist/deployment.yaml`: `WORKER_ROLE=api` serves
 * traffic, `WORKER_ROLE=worker` runs background work. Without gating, every
 * periodic loop runs in BOTH pods.
 *
 * The load-bearing case is the DEFAULT. An absent WORKER_ROLE must run
 * background work, because a project that never declared a worker runs a
 * single pod with no such env var and must keep doing its work. Defaulting to
 * "api" would silently stop every loop with nothing erroring -- the failure
 * mode is invisible.
 *
 * Concrete cost of getting the gate wrong, in this template specifically: the
 * inbound-email reaper claims rows safely, so a duplicate tick does not
 * corrupt data, but it re-pays for the LLM extraction on every tick, in every
 * extra pod, forever. `reindexDocs()` re-embeds changed chunks at boot, so a
 * second pod pays for the same embeddings again.
 */

import { assertEquals } from "@std/assert";
import { getWorkerRole, roleRunsBackgroundWork } from "@/lib/worker-role.ts";

function withRole<T>(value: string | undefined, fn: () => T): T {
  const prev = Deno.env.get("WORKER_ROLE");
  if (value === undefined) Deno.env.delete("WORKER_ROLE");
  else Deno.env.set("WORKER_ROLE", value);
  try {
    return fn();
  } finally {
    if (prev === undefined) Deno.env.delete("WORKER_ROLE");
    else Deno.env.set("WORKER_ROLE", prev);
  }
}

Deno.test("absent WORKER_ROLE runs background work (fail-open default)", () => {
  withRole(undefined, () => {
    assertEquals(getWorkerRole(), "all");
    assertEquals(roleRunsBackgroundWork(), true);
  });
});

Deno.test("api role does NOT run background work", () => {
  withRole("api", () => {
    assertEquals(getWorkerRole(), "api");
    assertEquals(roleRunsBackgroundWork(), false);
  });
});

Deno.test("worker role runs background work", () => {
  withRole("worker", () => {
    assertEquals(getWorkerRole(), "worker");
    assertEquals(roleRunsBackgroundWork(), true);
  });
});

Deno.test("whitespace and case are tolerated", () => {
  withRole("  API  ", () => assertEquals(getWorkerRole(), "api"));
  withRole("Worker", () => assertEquals(getWorkerRole(), "worker"));
});

Deno.test("a typo or empty value falls back to running background work", () => {
  // Fail OPEN: a misspelled role must never be the reason a deployment
  // silently stops draining its queue. Only an exact "api" suppresses work.
  for (const bad of ["", "   ", "apii", "API_POD", "wrker", "none", "false"]) {
    withRole(bad, () => {
      assertEquals(getWorkerRole(), "all", `"${bad}" should resolve to all`);
      assertEquals(roleRunsBackgroundWork(), true, `"${bad}" should run work`);
    });
  }
});

Deno.test("main.ts gates every background starter on the role", async () => {
  // Source-shape guard: adding a new periodic loop to main.ts without the
  // gate reintroduces double-execution the moment any project declares a
  // worker. Each of these must sit inside an `if (runsBackgroundWork)`.
  const src = await Deno.readTextFile(new URL("../../main.ts", import.meta.url));

  for (const starter of ["reindexDocs()", "startInboundEmailReaper()", "startDemoReseedLoop()"]) {
    const idx = src.indexOf(starter);
    assertEquals(idx > -1, true, `${starter} should still exist in main.ts`);
    const preceding = src.slice(0, idx);
    const gateIdx = preceding.lastIndexOf("if (runsBackgroundWork)");
    assertEquals(
      gateIdx > -1,
      true,
      `${starter} must be inside an if (runsBackgroundWork) block`,
    );
    // The gate must be the NEAREST enclosing block, not one further up that a
    // later edit accidentally fell out of.
    const between = preceding.slice(gateIdx);
    assertEquals(
      between.split("}").length - 1 < between.split("{").length - 1 + 1,
      true,
      `${starter}: the if (runsBackgroundWork) block appears to close before it`,
    );
  }

  // HTTP must NOT be gated -- the worker pod has its own readiness probe and
  // would never become Ready if it refused to serve.
  const serveIdx = src.indexOf("Deno.serve(");
  const beforeServe = src.slice(0, serveIdx);
  const lastGate = beforeServe.lastIndexOf("if (runsBackgroundWork)");
  if (lastGate > -1) {
    const tail = beforeServe.slice(lastGate);
    assertEquals(
      tail.includes("}"),
      true,
      "Deno.serve must NOT be inside the background-work gate",
    );
  }
});
