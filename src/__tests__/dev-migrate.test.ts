/**
 * The dev server applies pending migrations on every start, and restarts when
 * a migration file is added, so a Builder preview never serves a schema that
 * is missing a table an agent just added.
 */
import { assertEquals, assertStringIncludes } from "@std/assert";
import { type DevBootEnv, migrateOnDevBoot } from "../lib/dev-migrate.ts";

// Never set DATABASE_URL or ALCHEMIST_DEV_ROUTES here: `deno test --parallel`
// shares one process environment, so a fake DATABASE_URL leaks into other test
// files' DB connections. Pass the boot env explicitly instead.
const DEV: DevBootEnv = { devRoutes: true, databaseUrl: "postgres://x@localhost/db" };

Deno.test("dev boot runs the migrations from db/migrations/", async () => {
  const dirs: string[] = [];
  assertEquals(
    await migrateOnDevBoot(async ({ migrationsDir }) => void dirs.push(migrationsDir), DEV),
    "applied",
  );
  assertEquals(dirs.length, 1);
  assertEquals(dirs[0].endsWith("/db/migrations/"), true);
});

Deno.test("production (no dev routes) and a missing database skip it", async () => {
  let ran = 0;
  const run = async () => void ran++;
  assertEquals(await migrateOnDevBoot(run, { ...DEV, devRoutes: false }), "skipped");
  assertEquals(await migrateOnDevBoot(run, { ...DEV, databaseUrl: undefined }), "skipped");
  assertEquals(ran, 0);
});

Deno.test("a failed migration does not stop the server from booting", async () => {
  assertEquals(
    await migrateOnDevBoot(() => Promise.reject(new Error("syntax error")), DEV),
    "failed",
  );
});

Deno.test("dev-migrate tests never touch the shared process environment (source pin)", async () => {
  const self = await Deno.readTextFile(new URL(import.meta.url));
  assertEquals(self.includes("Deno.env." + "set("), false);
  assertEquals(self.includes("Deno.env." + "delete("), false);
});

Deno.test("main.ts migrates before connecting, and dev restarts on new migrations (source pin)", async () => {
  const main = await Deno.readTextFile(new URL("../../main.ts", import.meta.url));
  const migrateAt = main.indexOf("await migrateOnDevBoot();");
  const initAt = main.indexOf("await initDatabase();");
  assertEquals(migrateAt > 0 && migrateAt < initAt, true);
  const denoJson = await Deno.readTextFile(new URL("../../deno.json", import.meta.url));
  assertStringIncludes(denoJson, "--watch=db/migrations/");
});
