/**
 * Kysely aggregates that take a column must come from the query's own
 * expression builder, never from the bare database object:
 *
 *   .select((eb) => [eb.fn.max("receivedAt").as("last")])   // scoped: fast
 *   .select([db.fn.max("receivedAt").as("last")])            // unscoped: slow
 *
 * `db.fn` is not scoped to the query's tables, so TypeScript resolves the
 * column name against every column of every table in `Database`. In the
 * Chipp platform repo one such call cost ~33s of every type check (4.06M
 * type instantiations for one statement); the callback form checked the same
 * statement in 0.045s with the same result type. The cost grows with the
 * schema, so it bites a project late. `db.fn.countAll()` takes no column and
 * is exempt.
 */
import { assertEquals } from "@std/assert";

const ROOT = new URL("../../", import.meta.url).pathname;

/** `db.fn.max("col")`, `trx.fn.count<number>("id")`, `this.db.fn.sum('x')`. */
const UNSCOPED_FN_COLUMN_RE =
  /\b(?:db|trx|tx)\.fn\.(?:count|max|min|sum|avg|agg|coalesce)\s*(?:<[^>()]*>)?\(\s*["'`]/;

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

function serverFiles(dir: string, out: string[] = []): string[] {
  for (const e of Deno.readDirSync(dir)) {
    const p = `${dir}/${e.name}`;
    if (e.isDirectory) {
      if (e.name !== "__tests__" && e.name !== "node_modules" && !e.name.startsWith(".")) {
        serverFiles(p, out);
      }
    } else if (e.name.endsWith(".ts") && !/[._]test\.ts$/.test(e.name)) {
      out.push(p);
    }
  }
  return out;
}

Deno.test("unscoped db.fn pattern: flags column aggregates on db/trx, not eb or countAll", () => {
  for (
    const s of ['db.fn.max("receivedAt")', 'db.fn.count<number>("id")', "trx.fn.sum('amount')"]
  ) {
    assertEquals(UNSCOPED_FN_COLUMN_RE.test(s), true, s);
  }
  for (const s of ['eb.fn.max("receivedAt")', "db.fn.countAll<number>()", 'fn.count("id")']) {
    assertEquals(UNSCOPED_FN_COLUMN_RE.test(s), false, s);
  }
});

Deno.test("no unscoped db.fn column aggregates in server code", () => {
  const offenders: string[] = [];
  for (const dir of ["src", "db"]) {
    let files: string[];
    try {
      files = serverFiles(`${ROOT}${dir}`);
    } catch {
      continue;
    }
    for (const f of files) {
      stripComments(Deno.readTextFileSync(f)).split("\n").forEach((line, i) => {
        if (UNSCOPED_FN_COLUMN_RE.test(line)) {
          offenders.push(`${f.slice(ROOT.length)}:${i + 1}: ${line.trim()}`);
        }
      });
    }
  }
  assertEquals(
    offenders,
    [],
    `Use the query's expression builder: .select((eb) => [eb.fn.max("col").as("x")]).\n${
      offenders.join("\n")
    }`,
  );
});
