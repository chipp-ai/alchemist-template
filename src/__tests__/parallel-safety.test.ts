/**
 * Parallel-safety: deterministic-under-parallelism guard (VALORV-494).
 *
 * Two layers:
 *   1. findParallelHazards unit tests — the authoring rule set.
 *   2. A meta-scan of every test file (no parallel-unsafe destructive SQL).
 *   3. An isolation-wiring assertion — under the `test*` tasks each worker must
 *      be pinned to its own `test_p<pid>` schema (the determinism guarantee).
 */

import { assert, assertEquals } from "@std/assert";
import { findParallelHazards } from "./parallel-safety.ts";
import { isDatabaseConfigured, testSchemaName } from "@/db/client.ts";

// ── 1. Rule-set unit tests ──

Deno.test("findParallelHazards: flags TRUNCATE", () => {
  const h = findParallelHazards("await sql`TRUNCATE shipments`;");
  assertEquals(h.length, 1);
  assertEquals(h[0].rule, "truncate");
});

Deno.test("findParallelHazards: flags DROP TABLE", () => {
  assertEquals(findParallelHazards("await sql`DROP TABLE users`;")[0].rule, "drop-table");
});

Deno.test("findParallelHazards: flags an un-scoped one-line DELETE/UPDATE", () => {
  assertEquals(findParallelHazards("await sql`DELETE FROM users`;")[0].rule, "unscoped-write");
  assertEquals(findParallelHazards("await sql`UPDATE users SET x = 1`;")[0].rule, "unscoped-write");
});

Deno.test("findParallelHazards: a WHERE-scoped delete is SAFE", () => {
  assertEquals(findParallelHazards("await sql`DELETE FROM users WHERE id = ${id}`;"), []);
});

Deno.test("findParallelHazards: an inline parallel-safe-ignore opts a line out", () => {
  // Same-line marker.
  assertEquals(
    findParallelHazards("await sql`DELETE FROM users`; // parallel-safe-ignore: global reset"),
    [],
  );
  // Preceding-line marker.
  assertEquals(
    findParallelHazards("// parallel-safe-ignore: lock-coordinated\nawait sql`DELETE FROM users`;"),
    [],
  );
  // Without the marker it is still flagged.
  assertEquals(findParallelHazards("await sql`DELETE FROM users`;")[0].rule, "unscoped-write");
});

Deno.test("findParallelHazards: a multi-line delete (WHERE on next line) is not falsely flagged", () => {
  // Only the first line has DELETE FROM but no closing backtick → not flagged.
  const src = "await sql`DELETE FROM users\n  WHERE org_id = ${org.id}`;";
  assertEquals(findParallelHazards(src), []);
});

Deno.test("findParallelHazards: a scoped count + clean code is SAFE", () => {
  const src = "const n = await sql`SELECT count(*) FROM users WHERE organization_id = ${org.id}`;";
  assertEquals(findParallelHazards(src), []);
});

// ── 2. Meta-scan: no test file ships a parallel-unsafe destructive pattern ──

async function* walkTs(dir: string): AsyncGenerator<string> {
  for await (const entry of Deno.readDir(dir)) {
    const path = `${dir}/${entry.name}`;
    if (entry.isDirectory) yield* walkTs(path);
    else if (entry.isFile && path.endsWith(".ts")) yield path;
  }
}

Deno.test("no test file contains a parallel-unsafe destructive SQL pattern", async () => {
  const hazards: string[] = [];
  for await (const path of walkTs("src/__tests__")) {
    if (path.includes("parallel-safety")) continue; // this file documents the patterns
    const src = await Deno.readTextFile(path);
    for (const h of findParallelHazards(src)) {
      hazards.push(`${path}:${h.line} [${h.rule}] ${h.snippet}`);
    }
  }
  assertEquals(
    hazards,
    [],
    `parallel-unsafe patterns found (scope deletes with WHERE; never TRUNCATE/DROP in a test):\n${
      hazards.join("\n")
    }`,
  );
});

// ── 3. Isolation wiring: each worker → its own schema ──

Deno.test("parallel-test isolation is wired: worker is pinned to its own schema", () => {
  // Only meaningful under the `test*` tasks (which set TEST_PARALLEL_ISOLATION=1).
  // A direct `deno test` without the flag legitimately runs un-isolated.
  if (Deno.env.get("TEST_PARALLEL_ISOLATION") !== "1") return;
  if (!isDatabaseConfigured()) return; // no DB configured → nothing to isolate
  assert(
    testSchemaName !== null,
    "per-worker schema isolation must be active under the test tasks",
  );
  // The name is `test_p<pid>_<random>` — the random suffix is what makes it
  // unique PER ISOLATE (workers share Deno.pid), so assert the shape, not a
  // pid-exact value. A bare `test_p<pid>` (no suffix) would be the old, broken,
  // collision-prone key.
  assert(
    /^test_p\d+_[0-9a-f]{12}$/.test(testSchemaName!),
    `schema must be a per-isolate test schema (test_p<pid>_<random>), got: ${testSchemaName}`,
  );
});
