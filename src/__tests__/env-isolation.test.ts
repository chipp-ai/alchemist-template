/**
 * Pins the env-isolation rules from src/lib/env.ts:
 * - no test file mutates the process environment (Deno.env.set/delete), because
 *   `deno test --parallel` shares it across every test file;
 * - server code reads env through getEnv()/envObject(), so a test's
 *   __setEnvForTest() override actually reaches it.
 * A failure lists each file:line and the exact replacement.
 */
import { assertEquals } from "@std/assert";
import { __deleteEnvForTest, __setEnvForTest, envObject, getEnv } from "@/lib/env.ts";

async function tsFiles(dir: URL): Promise<string[]> {
  const out: string[] = [];
  for await (const e of Deno.readDir(dir)) {
    const u = new URL(e.name + (e.isDirectory ? "/" : ""), dir);
    if (e.isDirectory) out.push(...await tsFiles(u));
    else if (e.name.endsWith(".ts")) out.push(u.pathname);
  }
  return out.sort();
}

/** Blank out comments (keeping line numbers) so prose that names Deno.env is fine. */
function code(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, " "))
    .replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1");
}

const SRC = new URL("../", import.meta.url);
const TESTS = new URL("./", import.meta.url);
const SELF = new URL(import.meta.url).pathname;

const FIX: Record<string, string> = {
  "Deno.env.get(": 'getEnv(   (import { getEnv } from "@/lib/env.ts")',
  "Deno.env.toObject(": 'envObject(   (import { envObject } from "@/lib/env.ts")',
  "Deno.env.has(": 'getEnv(KEY) !== undefined   (import { getEnv } from "@/lib/env.ts")',
  "Deno.env.set(": '__setEnvForTest(   (import { __setEnvForTest } from "@/lib/env.ts")',
  "Deno.env.delete(": '__deleteEnvForTest(   (import { __deleteEnvForTest } from "@/lib/env.ts")',
  "Deno.env": 'envReader   (import { envReader } from "@/lib/env.ts"; same get/has/toObject)',
};

async function offenders(files: string[], pattern: RegExp): Promise<string[]> {
  const out: string[] = [];
  for (const f of files) {
    const lines = code(await Deno.readTextFile(f)).split("\n");
    lines.forEach((line, i) => {
      for (const m of line.matchAll(pattern)) {
        out.push(`src/${f.slice(SRC.pathname.length)}:${i + 1}: replace ${m[0]} with ${FIX[m[0]]}`);
      }
    });
  }
  return out;
}

Deno.test("no test file mutates the shared process environment", async () => {
  const files = (await tsFiles(TESTS)).filter((f) => f !== SELF);
  const bad = await offenders(files, /Deno\.env\.(?:set|delete)\(/g);
  assertEquals(
    bad,
    [],
    "deno test --parallel shares one process env across test files; override env per file instead:\n" +
      bad.join("\n"),
  );
});

Deno.test("server code reads env through getEnv()/envObject()", async () => {
  const files = (await tsFiles(SRC)).filter((f) =>
    !f.startsWith(TESTS.pathname) && !f.endsWith("/lib/env.ts")
  );
  const bad = await offenders(files, /Deno\.env\.(?:get|toObject|has|set|delete)\(|Deno\.env(?![.\w])/g);
  assertEquals(
    bad,
    [],
    "server code must read env through src/lib/env.ts so test overrides reach it:\n" +
      bad.join("\n"),
  );
});

Deno.test("an override is visible through getEnv and envObject, and a delete hides the key", () => {
  __setEnvForTest("ENV_ISOLATION_PROBE", "on");
  assertEquals(getEnv("ENV_ISOLATION_PROBE"), "on");
  assertEquals(envObject().ENV_ISOLATION_PROBE, "on");
  assertEquals(Deno.env.get("ENV_ISOLATION_PROBE"), undefined, "the process env is untouched");
  __deleteEnvForTest("ENV_ISOLATION_PROBE");
  assertEquals(getEnv("ENV_ISOLATION_PROBE"), undefined);
  assertEquals("ENV_ISOLATION_PROBE" in envObject(), false);
});
