/**
 * /health must not query the database on every probe: a healthy check is
 * reused for HEALTH_DB_CACHE_MS, an unhealthy one never is, and /live never
 * touches the database.
 */
import { assertEquals } from "@std/assert";
import {
  cachedDatabaseCheck,
  createHealthRoutes,
  HEALTH_DB_CACHE_MS,
} from "@/api/routes/health/index.ts";

Deno.test("a healthy check is reused until it expires", async () => {
  let calls = 0;
  let t = 1_000;
  const check = cachedDatabaseCheck(() => {
    calls++;
    return Promise.resolve("ok");
  }, () => t);
  await check();
  t += HEALTH_DB_CACHE_MS - 1;
  await check();
  assertEquals(calls, 1);
  t += 2;
  await check();
  assertEquals(calls, 2);
});

Deno.test("an unhealthy check is never reused", async () => {
  let calls = 0;
  const check = cachedDatabaseCheck(() => {
    calls++;
    return Promise.resolve("degraded");
  }, () => 0);
  assertEquals(await check(), "degraded");
  assertEquals(await check(), "degraded");
  assertEquals(calls, 2);
});

Deno.test("concurrent probes share one query", async () => {
  let calls = 0;
  const check = cachedDatabaseCheck(() => {
    calls++;
    return new Promise((r) => setTimeout(() => r("ok"), 5));
  }, () => 0);
  await Promise.all([check(), check(), check()]);
  assertEquals(calls, 1);
});

Deno.test("/live answers without the database; /ready reports a degraded database", async () => {
  let calls = 0;
  const app = createHealthRoutes(() => {
    calls++;
    return Promise.resolve("degraded");
  });
  const live = await app.request("/live");
  assertEquals(live.status, 200);
  assertEquals(calls, 0);
  assertEquals((await app.request("/ready")).status, 503);
  assertEquals((await (await app.request("/health")).json()).db, "degraded");
});
