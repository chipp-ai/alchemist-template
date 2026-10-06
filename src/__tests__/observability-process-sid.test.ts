/**
 * Only the dev server's entry (`main.ts`) logs under a `srv-` id. Tests and
 * scripts share the log file, and their lines must not read as a server
 * restart.
 */
import { assertEquals } from "@std/assert";
import { processSidPrefix } from "../observability/envelope.ts";

Deno.test("the dev server entry is srv", () => {
  assertEquals(processSidPrefix("file:///workspace/main.ts"), "srv");
});

Deno.test("test files are test", () => {
  assertEquals(processSidPrefix("file:///workspace/src/__tests__/services/habits.test.ts"), "test");
  assertEquals(processSidPrefix("file:///workspace/src/foo_test.ts"), "test");
  assertEquals(processSidPrefix("file:///workspace/src/__tests__/helpers.ts"), "test");
});

Deno.test("anything else is a script", () => {
  assertEquals(processSidPrefix("file:///workspace/db/migrate.ts"), "script");
  assertEquals(processSidPrefix("file:///workspace/scripts/seed.ts"), "script");
  assertEquals(processSidPrefix(""), "script");
});

Deno.test("this test process itself logs as test", async () => {
  const src = await Deno.readTextFile(new URL("../observability/envelope.ts", import.meta.url));
  assertEquals(src.includes("`srv-${Date.now()}"), false);
  assertEquals(processSidPrefix(Deno.mainModule), "test");
});
