/**
 * Storefront router discovery (src/services/storefront/{router,mounts}.ts).
 * DB-free. Uses temp directories, so it passes the same way in the base
 * template and in a project whose recipe added route modules.
 */

import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { Hono } from "hono";
import { discoverRouteModules, mountPublicRoutes } from "@/services/storefront/mounts.ts";
import { storefrontRouter } from "@/services/storefront/router.ts";

async function withTempDir(files: Record<string, string>, fn: (dir: URL) => Promise<void>) {
  const path = await Deno.makeTempDir();
  try {
    for (const [name, content] of Object.entries(files)) {
      await Deno.writeTextFile(`${path}/${name}`, content);
    }
    await fn(new URL(`file://${path}/`));
  } finally {
    await Deno.remove(path, { recursive: true });
  }
}

function routeModule(path: string, body: string): string {
  // The import map applies to every module in the process, temp files too.
  return `import { Hono } from "hono";\n` +
    `const r = new Hono();\nr.get(${JSON.stringify(path)}, (c) => c.text(${JSON.stringify(body)}));\n` +
    `export default r;\n`;
}

Deno.test("discoverRouteModules: only *.routes.ts files, sorted; a missing dir is empty", async () => {
  await withTempDir({
    "b.routes.ts": "",
    "a.routes.ts": "",
    "helper.service.ts": "",
    "mounts.json": "{}",
    "notes.routes.md": "",
  }, async (dir) => {
    assertEquals(await discoverRouteModules(dir), ["./a.routes.ts", "./b.routes.ts"]);
  });
  assertEquals(await discoverRouteModules(new URL(`file:///nonexistent-${crypto.randomUUID()}/`)), []);
});

Deno.test("an empty storefront dir mounts nothing: every request falls through", async () => {
  await withTempDir({ "helper.ts": "export const x = 1;\n" }, async (dir) => {
    const app = new Hono();
    const mounted = await mountPublicRoutes(
      app,
      await discoverRouteModules(dir),
      (spec) => import(new URL(spec, dir).href),
    );
    assertEquals(mounted, []);
    app.get("*", (c) => c.text("spa-fallback"));
    assertEquals(await (await app.request("/")).text(), "spa-fallback");
  });
});

Deno.test("mountPublicRoutes mounts each module at / and leaves other paths to later routes", async () => {
  await withTempDir({
    "landing.routes.ts": routeModule("/", "landing"),
    "products.routes.ts": routeModule("/products", "products"),
  }, async (dir) => {
    const app = new Hono();
    const mounted = await mountPublicRoutes(
      app,
      await discoverRouteModules(dir),
      (spec) => import(new URL(spec, dir).href),
    );
    assertEquals(mounted, ["./landing.routes.ts", "./products.routes.ts"]);
    app.get("*", (c) => c.text("spa-fallback"));
    assertEquals(await (await app.request("/")).text(), "landing");
    assertEquals(await (await app.request("/products")).text(), "products");
    assertEquals(await (await app.request("/assets/app.js")).text(), "spa-fallback");
  });
});

Deno.test("mountPublicRoutes refuses a module without a default-exported router", async () => {
  const app = new Hono();
  const err = await assertRejects(
    () => mountPublicRoutes(app, ["./broken.routes.ts"], () => Promise.resolve({ default: 42 })),
    Error,
  );
  assertStringIncludes(err.message, "./broken.routes.ts must default-export a Hono router");
});

Deno.test("storefrontRouter is a Hono router the app can mount", () => {
  assertEquals(typeof storefrontRouter.fetch, "function");
});
