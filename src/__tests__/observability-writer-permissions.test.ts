/**
 * Regression test for the CI "Run tests" divergence (ALCHEM7-2): the
 * observability writer (src/observability/jsonl-writer.ts) is supposed to
 * go silent after the FIRST permission failure when the process wasn't
 * granted `--allow-write` -- exactly the CI test job's permission set
 * before this fix (and still a supported no-write context, e.g.
 * `deno run --allow-net --allow-env --allow-read db/migrate.ts`).
 *
 * Deno 2 throws `Deno.errors.NotCapable` (not `PermissionDenied`) when a
 * permission was simply never requested/granted. The writer's latch only
 * checked for `PermissionDenied`, so under Deno 2 every single log emit
 * in a no-write context re-threw-and-caught NotCapable indefinitely
 * instead of latching off after the first hit. This test spawns a real
 * subprocess WITHOUT `--allow-write` (mirroring the CI condition) and
 * asserts the process still exits 0 -- i.e. the writer's fallback never
 * escalates into an uncaught exception that would fail the run.
 */

import { assertEquals } from "@std/assert";

Deno.test({
  name:
    "appendLineSync: never throws (process exits 0) when the process lacks --allow-write, even across many log emits",
  // Spawns a Deno subprocess -- the resource/op sanitizer doesn't apply
  // meaningfully to a short-lived child process wait.
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const script = `
      import { appendLineSync } from "${new URL("../observability/jsonl-writer.ts", import.meta.url).href}";
      // Multiple emits: the first hits the permission error and must latch
      // off; subsequent calls must be silent no-ops, not repeated throws.
      for (let i = 0; i < 5; i++) {
        appendLineSync(JSON.stringify({ i }));
      }
      console.log("DONE");
    `;
    const scriptPath = await Deno.makeTempFile({ suffix: ".ts" });
    await Deno.writeTextFile(scriptPath, script);

    let code: number, out: string, err: string;
    try {
      const command = new Deno.Command(Deno.execPath(), {
        args: ["run", "--allow-net", "--allow-env", "--allow-read", scriptPath],
        stdout: "piped",
        stderr: "piped",
      });
      const result = await command.output();
      code = result.code;
      out = new TextDecoder().decode(result.stdout);
      err = new TextDecoder().decode(result.stderr);
    } finally {
      await Deno.remove(scriptPath);
    }

    assertEquals(
      code,
      0,
      `subprocess must exit 0 -- the writer must never surface an uncaught exception. stderr:\n${err}`,
    );
    assertEquals(out.includes("DONE"), true, "script must run to completion past all 5 appendLineSync calls");

    // The latch (writeDisabled) must trip on the FIRST permission failure
    // so the remaining 4 emits are silent no-ops that never even reach a
    // console.warn -- not 5 independent thrown-and-caught-and-logged
    // errors. Before this fix, Deno 2's `NotCapable` (as opposed to
    // `PermissionDenied`) slipped past the latch check on every single
    // call, so this count was 5, not 0.
    const failureCount = (err.match(/\[observability\] write failed/g) ?? []).length;
    assertEquals(
      failureCount,
      0,
      `expected the permission failure to latch off silently (no warnings logged), got ${failureCount}. stderr:\n${err}`,
    );
  },
});
