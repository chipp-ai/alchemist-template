/**
 * Route access default (src/api/middleware/route-access.ts): an app route
 * under /api/ requires sign-in unless it is marked publicRoute("<reason>").
 * Security invariant (2026-11-26, the Lovable 30% email leak study): a route
 * whose author forgot requireAuth must still answer 401 to a stranger.
 *
 * No DB: every protected case is a request with no session, which
 * requireAuth refuses before it reads anything.
 */
import { assertEquals, assertThrows } from "@std/assert";
import { Hono } from "hono";
import { apiAuthByDefault, isTemplateApiPath, publicRoute } from "@/api/middleware/route-access.ts";
import { AppError } from "@/utils/errors.ts";

function buildApp() {
  const app = new Hono();
  app.onError((err, c) =>
    err instanceof AppError ? c.json({ error: err.message }, err.statusCode as 401) : c.json({ error: "x" }, 500)
  );
  app.use("/api/*", apiAuthByDefault);

  const leads = new Hono();
  // The author forgot requireAuth: the default still protects it.
  leads.get("/", (c) => c.json({ data: [{ id: 1, email: "a@b.co" }] }));
  leads.post("/", publicRoute("contact form on the marketing site"), (c) => c.json({ ok: true }, 201));
  app.route("/api/leads-app", leads);

  // A sub-app with its own onError: Hono wraps its handlers, the marker must still be seen.
  const wrapped = new Hono();
  wrapped.onError((_e, c) => c.json({ error: "sub" }, 500));
  wrapped.get("/open", publicRoute("public price list"), (c) => c.json({ ok: true }));
  wrapped.get("/closed", (c) => c.json({ ok: true }));
  app.route("/api/prices", wrapped);

  // A template surface: its router does its own check, so the default lets it through.
  app.get("/api/auth/config", (c) => c.json({ ok: true }));
  return app;
}

Deno.test("route access: an app route with no auth answers 401 to a stranger", async () => {
  const res = await buildApp().request("/api/leads-app");
  assertEquals(res.status, 401);
  await res.body?.cancel();
});

Deno.test("route access: a publicRoute is open, also inside a sub-app with its own onError", async () => {
  const app = buildApp();
  for (const [method, path, status] of [["POST", "/api/leads-app", 201], ["GET", "/api/prices/open", 200]] as const) {
    const res = await app.request(path, { method });
    assertEquals(res.status, status, `${method} ${path}`);
    await res.body?.cancel();
  }
  const closed = await app.request("/api/prices/closed");
  assertEquals(closed.status, 401);
  await closed.body?.cancel();
});

Deno.test("route access: template surfaces and unknown paths are not intercepted", async () => {
  const app = buildApp();
  const auth = await app.request("/api/auth/config");
  assertEquals(auth.status, 200);
  await auth.body?.cancel();
  const missing = await app.request("/api/nothing-here");
  assertEquals(missing.status, 404);
  await missing.body?.cancel();
  assertEquals(isTemplateApiPath("/api/authority"), false, "prefix match is per path segment");
});

Deno.test("route access: publicRoute needs a reason", () => {
  assertThrows(() => publicRoute(""));
  assertThrows(() => publicRoute("   "));
});
