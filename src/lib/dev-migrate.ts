/**
 * Apply pending migrations every time the DEV server starts.
 *
 * The Builder preview ran `deno task db:migrate` once, at first boot. A
 * migration an agent added later never applied when `deno task dev`
 * restarted on a code change, so the preview served a schema without the
 * new tables until someone ran the migrate task by hand. Production is
 * unaffected: the image's CMD migrates before main.ts, and production never
 * sets ALCHEMIST_DEV_ROUTES.
 */
import { devRoutesEnabled } from "@/lib/dev-mode.ts";
import { log } from "@/lib/logger.ts";

type RunMigrations = (options: { migrationsDir: string }) => Promise<void>;

export async function migrateOnDevBoot(
  run: RunMigrations = async (options) =>
    (await import("../../db/_runner.ts")).runMigrations(options),
): Promise<"skipped" | "applied" | "failed"> {
  if (!devRoutesEnabled() || !Deno.env.get("DATABASE_URL")) return "skipped";
  try {
    await run({ migrationsDir: new URL("../../db/migrations/", import.meta.url).pathname });
    return "applied";
  } catch (err) {
    // The server still boots; the log says why the new tables are missing.
    log.error("Dev boot migration failed", { source: "startup", feature: "dev-migrate" }, err);
    return "failed";
  }
}
