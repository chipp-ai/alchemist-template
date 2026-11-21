/**
 * The contract the Chipp Builder preview's edge sign-in relies on
 * (chipp-deno cloudflare-worker/src/preview-dev-sign-in.ts, 2026-11-21).
 *
 * On a builder's own page load the edge calls GET /api/auth/me. A 401 means
 * "signed out", and the edge then calls POST /api/dev/login as
 * dev@example.com and hands the browser that session cookie with the page.
 * So the builder never sees the app's sign-in page in the Builder preview.
 *
 * Two promises keep that safe and working:
 * - /api/dev/login is dead in a published build: the dev surface is off
 *   unless ALCHEMIST_DEV_ROUTES is set, and only `deno task dev` and the
 *   sandbox preview script set it. A published app can never mint the dev
 *   account's session.
 * - GET /api/auth/me answers 401 to a signed-out caller. If it answered 200
 *   with `user: null` (as /api/auth/session does), the edge would think the
 *   builder was signed in and they would see the sign-in page again.
 */

import { assert, assertEquals } from "@std/assert";
import { withTestServer } from "../helpers.ts";
import { devRoutes } from "@/api/routes/dev/index.ts";
import { authRoutes } from "@/api/routes/auth/index.ts";
import { __deleteEnvForTest, __setEnvForTest, getEnv } from "@/lib/env.ts";

function deno(name: string, fn: () => void | Promise<void>) {
  Deno.test({ name, sanitizeResources: false, sanitizeOps: false, fn });
}

function setDevRoutes(value: string | null): () => void {
  const prev = getEnv("ALCHEMIST_DEV_ROUTES");
  if (value === null) __deleteEnvForTest("ALCHEMIST_DEV_ROUTES");
  else __setEnvForTest("ALCHEMIST_DEV_ROUTES", value);
  return () => {
    if (prev === undefined) __deleteEnvForTest("ALCHEMIST_DEV_ROUTES");
    else __setEnvForTest("ALCHEMIST_DEV_ROUTES", prev);
  };
}

const devLogin = (app: ReturnType<typeof withTestServer>) =>
  app.request("/api/dev/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "dev@example.com" }),
  });

for (const flag of [null, "", "0", "false", "yes"]) {
  deno(`a published build (ALCHEMIST_DEV_ROUTES=${JSON.stringify(flag)}) has no dev sign-in`, async () => {
    const restore = setDevRoutes(flag);
    try {
      const app = withTestServer((a) => a.route("/api/dev", devRoutes));
      const res = await devLogin(app);
      assertEquals(res.status, 404);
      assertEquals(res.headers.getSetCookie(), [], "no session cookie, ever");
      const viaGet = await app.request("/api/dev/login?email=dev%40example.com&redirect=%2F");
      assertEquals(viaGet.status, 404);
      assertEquals(viaGet.headers.getSetCookie(), []);
    } finally {
      restore();
    }
  });
}

deno("GET /api/auth/me answers a signed-out caller with 401", async () => {
  const app = withTestServer((a) => a.route("/api/auth", authRoutes));
  assertEquals((await app.request("/api/auth/me")).status, 401);
  const garbage = await app.request("/api/auth/me", { headers: { cookie: "session_id=not-a-jwt" } });
  assertEquals(garbage.status, 401);
});

deno("only the dev tasks turn the dev surface on, never the deploy image", async () => {
  const deno = JSON.parse(await Deno.readTextFile(new URL("../../../deno.json", import.meta.url))) as {
    tasks: Record<string, string>;
  };
  const withFlag = Object.entries(deno.tasks)
    .filter(([, cmd]) => /ALCHEMIST_DEV_ROUTES=/.test(cmd))
    .map(([name]) => name);
  assertEquals(withFlag, ["dev"]);
  const dockerfile = await Deno.readTextFile(new URL("../../../Dockerfile", import.meta.url));
  assert(!dockerfile.includes("ALCHEMIST_DEV_ROUTES"), "the deploy image must never set the dev flag");
});

deno("the sign-in page moves a signed-in user on, only when the server agrees, at most once per 10s", async () => {
  const login = await Deno.readTextFile(new URL("../../../web/src/routes/Login.svelte", import.meta.url));
  assert(login.includes("if (authStore.isAuthenticated && takeSignedInBounce())"));
  assert(login.includes(`fetch("/api/auth/session"`), "the server's answer, not the store's: the API client's 401 leaves the store signed in");
  assert(login.includes("if (body?.user) replace(takeReturnTo() ?? \"/\");"));
  assert(login.includes("const BOUNCE_GAP_MS = 10_000;"));
});
