/**
 * Authoring-time guard against parallel-unsafe tests (VALORV-494).
 *
 * Per-worker schema isolation (db/client.ts ensureTestSchema) makes cross-worker
 * DB races impossible, but a few patterns are flaky/destructive even so — and
 * this catches them at CI time so a flaky test can't be merged:
 *
 *   - TRUNCATE / DROP TABLE in a test → wipes the worker's whole table (every
 *     row, not just this test's), so a later test in the same file sees an empty
 *     table. Use createIsolatedUser + scoped deletes instead.
 *   - An un-scoped one-line DELETE/UPDATE (`sql`DELETE FROM users``) → same: it
 *     nukes rows other tests in the worker created. Always scope with a WHERE.
 *
 * Pure + exported so the rule set is unit-tested. The meta-test
 * (parallel-safety.test.ts) runs it over every file in src/__tests__.
 */

export interface Hazard {
  line: number;
  rule: string;
  snippet: string;
}

export function findParallelHazards(source: string): Hazard[] {
  const hazards: Hazard[] = [];
  source.split("\n").forEach((raw, i) => {
    const ln = i + 1;
    // Only EXECUTED SQL — single-line `sql`...`` tagged templates. This
    // deliberately ignores string assertions ABOUT source code
    // (`assertStringIncludes(src, `TRUNCATE ...`)`, plain "TRUNCATE" strings),
    // which are not `sql`-tagged, and multi-line templates whose opening line
    // has no closing backtick (the WHERE is on a later line → safe).
    const templates = raw.match(/\bsql`[^`]*`/gi) ?? [];
    for (const t of templates) {
      const snippet = t.trim().slice(0, 120);
      if (/\bTRUNCATE\b/i.test(t)) {
        hazards.push({ line: ln, rule: "truncate", snippet });
      } else if (/\bDROP\s+TABLE\b/i.test(t)) {
        hazards.push({ line: ln, rule: "drop-table", snippet });
      } else if (
        /\b(DELETE\s+FROM|UPDATE)\b/i.test(t) && !/\bWHERE\b/i.test(t)
      ) {
        hazards.push({ line: ln, rule: "unscoped-write", snippet });
      }
    }
  });
  return hazards;
}
