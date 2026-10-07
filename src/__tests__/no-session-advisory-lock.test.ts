/**
 * Guardrail: no session advisory locks in app code.
 *
 * DATABASE_URL goes through pgbouncer in transaction-pool mode. A session
 * advisory lock (`pg_try_advisory_lock` / `pg_advisory_lock`) lands on
 * whichever server connection served that statement, and the unlock can
 * land on another, so the lock leaks until pgbouncer recycles the
 * connection and every job tick on every pod skips. It happened in
 * production on 2026-08-01, 2026-09-04 and 2026-10-07, each time in code
 * copied from a scaffold. Use `withJobLock` (src/lib/job-lock.ts).
 *
 * Transaction-scoped locks (`pg_advisory_xact_lock`) are fine: the lock and
 * the work share one transaction, so pgbouncer pins one server connection.
 *
 * ALLOWED lists the only files that may take a session lock, each with the
 * reason. Test-schema provisioning runs on a reserved direct connection in
 * the test suite, never through pgbouncer.
 */
import { assertEquals } from "@std/assert";

const ALLOWED: Record<string, string> = {
  "src/db/client.ts": "test-schema provisioning on a reserved connection (tests only)",
};

const SESSION_LOCK = /pg_(try_)?advisory_lock\s*\(/;
const root = new URL("../../", import.meta.url);

async function* walk(dir: URL, rel: string): AsyncGenerator<string> {
  for await (const entry of Deno.readDir(dir)) {
    const childRel = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory) {
      if (
        entry.name === "node_modules" || entry.name === "__tests__" || entry.name.startsWith(".")
      ) continue;
      yield* walk(new URL(`${entry.name}/`, dir), childRel);
    } else if (/\.(ts|tsx|js|mjs)$/.test(entry.name)) {
      yield childRel;
    }
  }
}

Deno.test("no session advisory locks outside the allow-list (use withJobLock)", async () => {
  const offenders: string[] = [];
  for (const top of ["src", "db", "scripts"]) {
    try {
      await Deno.stat(new URL(`${top}/`, root));
    } catch {
      continue;
    }
    for await (const rel of walk(new URL(`${top}/`, root), top)) {
      if (ALLOWED[rel]) continue;
      const text = await Deno.readTextFile(new URL(rel, root));
      text.split("\n").forEach((line, i) => {
        if (SESSION_LOCK.test(line)) offenders.push(`${rel}:${i + 1}: ${line.trim()}`);
      });
    }
  }
  assertEquals(
    offenders,
    [],
    "session advisory lock found; use withJobLock from src/lib/job-lock.ts",
  );
});
