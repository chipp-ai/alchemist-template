/**
 * Pins the env-isolation rules from src/lib/env.ts:
 * - no test file mutates the process environment (Deno.env.set/delete), because
 *   `deno test --parallel` shares it across every test file;
 * - server code reads env through getEnv()/envObject(), so a test's
 *   __setEnvForTest() override actually reaches it.
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
  return out;
}

const SRC = new URL("../", import.meta.url);
const TESTS = new URL("./", import.meta.url);
const SELF = new URL(import.meta.url).pathname;

Deno.test("no test file mutates the shared process environment", async () => {
  const bad: string[] = [];
  for (const f of await tsFiles(TESTS)) {
    if (f === SELF) continue;
    const s = await Deno.readTextFile(f);
    if (/Deno\.env\.(set|delete)\(/.test(s)) bad.push(f.slice(SRC.pathname.length));
  }
  assertEquals(bad, [], "use __setEnvForTest/__deleteEnvForTest from src/lib/env.ts");
});

Deno.test("server code reads env through getEnv()/envObject()", async () => {
  const bad: string[] = [];
  for (const f of await tsFiles(SRC)) {
    if (f.startsWith(TESTS.pathname) || f.endsWith("/lib/env.ts")) continue;
    const s = await Deno.readTextFile(f);
    if (/Deno\.env\.(get|toObject|has|set|delete)\(/.test(s)) bad.push(f.slice(SRC.pathname.length));
  }
  assertEquals(bad, [], "read env with getEnv()/envObject() from src/lib/env.ts");
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
