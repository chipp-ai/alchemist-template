/**
 * The SPA fallback (src/lib/spa-fallback.ts). DB-free: a small Hono app in
 * the order app.ts uses (API, static files, fallback), against a throwaway
 * web build, so it never depends on `npm run build`.
 *
 * The case that matters: a hashed bundle this pod does not have must never
 * get the SPA shell with 200 (2026-10-19 Cloudflare cache poison).
 */

import { assertEquals, assertFalse, assertStringIncludes } from "@std/assert";
import { Hono } from "hono";
import { serveStatic } from "hono/deno";
import { isHashedAssetPath, spaFallbackMiddleware } from "@/lib/spa-fallback.ts";

const SHELL = "<!doctype html><html><body>SPA SHELL</body></html>";

async function webBuild(): Promise<string> {
  // Relative to the working directory: hono's serveStatic `path` is.
  await Deno.mkdir(".scratch", { recursive: true });
  const dir = await Deno.makeTempDir({ dir: ".scratch", prefix: "web-dist-" });
  await Deno.writeTextFile(`${dir}/index.html`, SHELL);
  await Deno.mkdir(`${dir}/assets`);
  await Deno.writeTextFile(`${dir}/assets/index-NEW.js`, "console.log('new')");
  return dir;
}

function buildApp(dir: string): Hono {
  const app = new Hono();
  app.get("/api/thing", (c) => c.json({ ok: true }));
  app.use("/*", serveStatic({ root: dir }));
  app.use("/*", spaFallbackMiddleware(`${dir}/index.html`));
  return app;
}

Deno.test("spa fallback: a missing hashed bundle is a 404 with no-store, never HTML", async () => {
  const dir = await webBuild();
  try {
    const app = buildApp(dir);
    for (const path of ["/assets/index-OLD.js", "/assets/index-OLD.css", "/_astro/site-OLD.css"]) {
      const res = await app.request(path);
      assertEquals(res.status, 404, path);
      assertEquals(res.headers.get("cache-control"), "no-store", path);
      assertFalse((res.headers.get("content-type") ?? "").includes("text/html"), path);
      assertFalse((await res.text()).includes("SPA SHELL"), path);
    }
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("spa fallback: a hashed bundle the pod has is still served", async () => {
  const dir = await webBuild();
  try {
    const res = await buildApp(dir).request("/assets/index-NEW.js");
    assertEquals(res.status, 200);
    assertStringIncludes(await res.text(), "new");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("spa fallback: a deep link gets the shell, marked as a fallback", async () => {
  const dir = await webBuild();
  try {
    const app = buildApp(dir);
    const deep = await app.request("/settings/profile");
    assertEquals(deep.status, 200);
    assertEquals(deep.headers.get("x-spa-fallback"), "1");
    assertStringIncludes(await deep.text(), "SPA SHELL");

    const root = await app.request("/");
    assertEquals(root.status, 200);
    assertEquals(root.headers.get("x-spa-fallback"), null);
    assertStringIncludes(await root.text(), "SPA SHELL");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("spa fallback: /api/* never gets the shell", async () => {
  const dir = await webBuild();
  try {
    const res = await buildApp(dir).request("/api/missing");
    assertEquals(res.status, 404);
    assertFalse((await res.text()).includes("SPA SHELL"));
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("isHashedAssetPath: only the hashed build prefixes", () => {
  assertEquals(isHashedAssetPath("/assets/index-abc.js"), true);
  assertEquals(isHashedAssetPath("/_astro/site.css"), true);
  assertEquals(isHashedAssetPath("/assets"), false);
  assertEquals(isHashedAssetPath("/blog/assets/x.png"), false);
  assertEquals(isHashedAssetPath("/favicon.svg"), false);
});
