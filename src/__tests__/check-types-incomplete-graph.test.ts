/**
 * `deno info --json` exits 0 when a module fails to load. It records the
 * module as `{ specifier, error }` with no local file, and the native type
 * check then sees the import's names as `any`: spurious errors, or a silent
 * pass. scripts/check-types.ts must retry a failed download and then refuse
 * a verdict (exit 2), never pass and never report a fake type error.
 * The guard lives in scripts/lib/tsgo-check.ts, copied from chipp-deno.
 */
import { assertEquals, assertStringIncludes } from "@std/assert";
import {
  type CommandResult,
  type DenoInfo,
  denoInfoGraph,
  infoModuleErrors,
  runTsgoCheck,
} from "../../scripts/lib/tsgo-check.ts";

const CLEAN_INFO: DenoInfo = {
  modules: [
    { specifier: "file:///repo/src/lib/redis.ts", local: "/repo/src/lib/redis.ts" },
    {
      specifier: "https://deno.land/x/redis@v0.32.4/redis.ts",
      local: "/cache/remote/https/deno.land/abc",
    },
  ],
};

/** What `deno info --json` prints (exit 0) when one remote module could not
 * be downloaded: `error` and no `local`. */
const ERRORED_INFO: DenoInfo = {
  modules: [
    { specifier: "file:///repo/src/lib/redis.ts", local: "/repo/src/lib/redis.ts" },
    {
      specifier: "https://deno.land/x/redis@v0.32.4/redis.ts",
      error: 'Import "https://deno.land/x/redis@v0.32.4/redis.ts" failed: error sending request',
    },
  ],
};

function fakeDeno(outputs: DenoInfo[]) {
  const calls: string[][] = [];
  const sleeps: number[] = [];
  const run = (_program: string, args: string[]): Promise<CommandResult> => {
    calls.push(args);
    const next = outputs[Math.min(calls.length - 1, outputs.length - 1)];
    return Promise.resolve({ code: 0, signal: null, stdout: JSON.stringify(next), stderr: "" });
  };
  const sleep = (ms: number) => {
    sleeps.push(ms);
    return Promise.resolve();
  };
  return { run, sleep, calls, sleeps };
}

Deno.test("infoModuleErrors: a clean graph has none; an errored remote module is listed", () => {
  assertEquals(infoModuleErrors(CLEAN_INFO), []);
  const errors = infoModuleErrors(ERRORED_INFO);
  assertEquals(errors.map((e) => e.specifier), ["https://deno.land/x/redis@v0.32.4/redis.ts"]);
});

Deno.test("denoInfoGraph: a clean graph passes on the first attempt", async () => {
  const deno = fakeDeno([CLEAN_INFO]);
  const r = await denoInfoGraph(deno.run, ["info", "--json", "main.ts"], { sleep: deno.sleep });
  assertEquals(r.kind, "ok");
  assertEquals(deno.calls.length, 1);
});

Deno.test("denoInfoGraph: an errored remote module is retried 3 times, then refused", async () => {
  const deno = fakeDeno([ERRORED_INFO]);
  const r = await denoInfoGraph(deno.run, ["info", "--json", "main.ts"], { sleep: deno.sleep });
  assertEquals(r.kind, "module-errors");
  if (r.kind === "module-errors") {
    assertEquals(r.attempts, 3);
    assertEquals(r.localOnly, false);
  }
  assertEquals(deno.calls.length, 3);
  assertEquals(deno.sleeps, [2000, 4000]);
});

Deno.test("denoInfoGraph: a download that succeeds on retry gives the complete graph", async () => {
  const deno = fakeDeno([ERRORED_INFO, CLEAN_INFO]);
  const r = await denoInfoGraph(deno.run, ["info", "--json", "main.ts"], { sleep: deno.sleep });
  assertEquals(r.kind, "ok");
  assertEquals(r.attempts, 2);
});

Deno.test("runTsgoCheck: an incomplete graph gets no verdict", async () => {
  let ran = 0;
  const verdict = await runTsgoCheck({
    infos: [ERRORED_INFO],
    localFileCount: 1,
    availableMb: 16_000,
    run: () => {
      ran++;
      return Promise.resolve({ code: 0, signal: null, stdout: "", stderr: "" });
    },
    log: () => {},
  });
  assertEquals(verdict.kind, "fallback");
  assertEquals(ran, 0);
});

Deno.test("check-types.ts: a remote module that cannot be loaded exits 2, never passes", async () => {
  const dir = Deno.realPathSync(await Deno.makeTempDir({ prefix: "check-types-incomplete-" }));
  try {
    // No --allow-import for the host, so `deno info` records an error and exits 0.
    Deno.writeTextFileSync(
      `${dir}/remote.ts`,
      'import { x } from "https://example.invalid/mod.ts";\nexport const v: number = x;\n',
    );
    const script = new URL("../../scripts/check-types.ts", import.meta.url).pathname;
    const out = await new Deno.Command(Deno.execPath(), {
      args: ["run", "--allow-read", "--allow-write", "--allow-run", "--allow-env", "--allow-sys", script, "remote.ts"],
      cwd: dir,
      env: { NO_COLOR: "1" },
      stdout: "piped",
      stderr: "piped",
    }).output();
    const text = new TextDecoder().decode(out.stdout) + new TextDecoder().decode(out.stderr);
    assertEquals(out.code, 2, text);
    assertStringIncludes(text, "https://example.invalid/mod.ts");
    assertStringIncludes(text, "refusing to type-check an incomplete graph");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
