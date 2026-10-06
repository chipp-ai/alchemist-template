/**
 * The dev server applies pending migrations on every start, and restarts when
 * a migration file is added, so a Builder preview never serves a schema that
 * is missing a table an agent just added.
 */
import { assertEquals, assertStringIncludes } from "@std/assert";
import { migrateOnDevBoot } from "../lib/dev-migrate.ts";

async function withEnv(env: Record<string, string | null>, fn: () => Promise<void>) {
  const prev = Object.fromEntries(Object.keys(env).map((k) => [k, Deno.env.get(k) ?? null]));
  const set = (vals: Record<string, string | null>) => {
    for (const [k, v] of Object.entries(vals)) v === null ? Deno.env.delete(k) : Deno.env.set(k, v);
  };
  set(env);
  try {
    await fn();
  } finally {
    set(prev);
  }
}

Deno.test("dev boot runs the migrations from db/migrations/", async () => {
  await withEnv(
    { ALCHEMIST_DEV_ROUTES: "1", DATABASE_URL: "postgres://x@localhost/db" },
    async () => {
      const dirs: string[] = [];
      assertEquals(
        await migrateOnDevBoot(async ({ migrationsDir }) => void dirs.push(migrationsDir)),
        "applied",
      );
      assertEquals(dirs.length, 1);
      assertEquals(dirs[0].endsWith("/db/migrations/"), true);
    },
  );
});

Deno.test("production (no dev routes) and a missing database skip it", async () => {
  let ran = 0;
  const run = async () => void ran++;
  await withEnv(
    { ALCHEMIST_DEV_ROUTES: null, DATABASE_URL: "postgres://x@localhost/db" },
    async () => {
      assertEquals(await migrateOnDevBoot(run), "skipped");
    },
  );
  await withEnv({ ALCHEMIST_DEV_ROUTES: "1", DATABASE_URL: null }, async () => {
    assertEquals(await migrateOnDevBoot(run), "skipped");
  });
  assertEquals(ran, 0);
});

Deno.test("a failed migration does not stop the server from booting", async () => {
  await withEnv(
    { ALCHEMIST_DEV_ROUTES: "1", DATABASE_URL: "postgres://x@localhost/db" },
    async () => {
      assertEquals(
        await migrateOnDevBoot(() => Promise.reject(new Error("syntax error"))),
        "failed",
      );
    },
  );
});

Deno.test("main.ts migrates before connecting, and dev restarts on new migrations (source pin)", async () => {
  const main = await Deno.readTextFile(new URL("../../main.ts", import.meta.url));
  const migrateAt = main.indexOf("await migrateOnDevBoot();");
  const initAt = main.indexOf("await initDatabase();");
  assertEquals(migrateAt > 0 && migrateAt < initAt, true);
  const denoJson = await Deno.readTextFile(new URL("../../deno.json", import.meta.url));
  assertStringIncludes(denoJson, "--watch=db/migrations/");
});
