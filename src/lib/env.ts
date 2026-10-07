/**
 * Process environment reads, with per-test-file overrides.
 *
 * `deno test --parallel` runs every test file in its own isolate but ONE
 * process, so `Deno.env.set()` in one test file changes the environment every
 * other file sees mid-run. That made tests fail at random (a fake DATABASE_URL
 * reached another file's DB client; one file's ALCHEMIST_DEV_ROUTES toggle
 * turned off another file's dev routes), and the CI bridge paid to "repair"
 * them.
 *
 * Server code reads env through getEnv()/envObject(). Tests override values
 * with __setEnvForTest()/__deleteEnvForTest(). The overrides live in this
 * module's state, which is per isolate, so they never leave the test file.
 * Production never calls the __ helpers, so getEnv() is Deno.env.get() there.
 * src/__tests__/env-isolation.test.ts pins both rules.
 */

/** A string value overrides; `null` hides the variable (as if unset). */
const overrides = new Map<string, string | null>();

/** Deno.env.get(), seen through this test file's overrides. */
export function getEnv(key: string): string | undefined {
  if (overrides.has(key)) return overrides.get(key) ?? undefined;
  return Deno.env.get(key);
}

/** Deno.env.toObject(), seen through this test file's overrides. */
export function envObject(): Record<string, string> {
  const out = Deno.env.toObject();
  for (const [key, value] of overrides) {
    if (value === null) delete out[key];
    else out[key] = value;
  }
  return out;
}

/** Test only: set `key` for this test file, without touching the process env. */
export function __setEnvForTest(key: string, value: string): void {
  overrides.set(key, value);
}

/** Test only: hide `key` for this test file, without touching the process env. */
export function __deleteEnvForTest(key: string): void {
  overrides.set(key, null);
}
