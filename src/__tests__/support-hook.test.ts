/**
 * Support page feature hook (source-shape test, no DB, no browser).
 *
 * The platform's app-support pack REPLACES the three support stubs
 * wholesale when a builder turns on "Support page for app users", and
 * restores them when it is turned off. The readers must keep importing the
 * names, and the base stubs must stay inert:
 *
 *   A. web/src/features/support.ts exports `supportRoutes`,
 *      `supportNavItems` and `supportPublicPaths`.
 *   B. routes.ts spreads `supportRoutes` before the catch-all, and both
 *      `isPublicRoute` and `isPortalRoute` consult `supportPublicPaths` by
 *      exact match only.
 *   C. Sidebar.svelte and PortalLayout.svelte read `supportNavItems`.
 *   D. app.ts mounts src/services/support/router.ts at /api/support, and
 *      the file exports `supportRouter`.
 *   E. agent-tools/index.ts imports src/services/support/agent-tools.ts.
 *
 * The "base is inert" checks run only while the stub still holds its base
 * content, so this test stays green in a project with the pack installed.
 */
import { assert, assertEquals } from "@std/assert";
// The SPA stub is read as text, never imported: with the pack installed it
// imports a .svelte page, which Deno cannot load.
import { Hono } from "hono";
import { supportRouter } from "@/services/support/router.ts";

const read = (rel: string) => Deno.readTextFile(new URL("../../" + rel, import.meta.url));
const BASE_MARKER = "EMPTY in the base template";

Deno.test("support hook: the SPA stub exports the three names", async () => {
  const src = await read("web/src/features/support.ts");
  assert(/export const supportRoutes\b/.test(src));
  assert(/export const supportNavItems\b/.test(src));
  assert(/export const supportPublicPaths\b/.test(src));
});

Deno.test("support hook: the base SPA stub is empty", async () => {
  const src = await read("web/src/features/support.ts");
  if (!src.includes(BASE_MARKER)) return; // pack installed
  assert(src.includes("export const supportRoutes: Record<string, any> = {};"));
  assert(src.includes("export const supportNavItems: SupportNavItem[] = [];"));
  assert(src.includes("export const supportPublicPaths: string[] = [];"));
  assert(!/^import /m.test(src), "the base stub imports nothing");
});

Deno.test("support hook: routes.ts spreads supportRoutes before the catch-all", async () => {
  const src = await read("web/src/routes.ts");
  assert(src.includes('import { supportPublicPaths, supportRoutes } from "./features/support";'));
  const spread = src.indexOf("...supportRoutes,");
  const catchAll = src.indexOf('"*": NotFound');
  assert(spread !== -1 && catchAll !== -1 && spread < catchAll);
});

Deno.test("support hook: public and portal checks use an exact match on supportPublicPaths", async () => {
  const src = await read("web/src/routes.ts");
  const fnBody = (name: string) => {
    const start = src.indexOf(`export function ${name}(`);
    assert(start !== -1, `${name} must exist`);
    return src.slice(start, src.indexOf("\n}\n", start));
  };
  const pub = fnBody("isPublicRoute");
  const portal = fnBody("isPortalRoute");
  // Exact match only: a prefix match would make every /support/* path public.
  assert(pub.includes("supportPublicPaths.includes(path)"));
  assert(portal.includes("supportPublicPaths.includes(path)"));
  assert(!/supportPublicPaths\.some/.test(pub + portal));
  // With the base stub, the support check adds nothing: the literal and
  // prefix sets are unchanged.
  assert(src.includes('const PUBLIC_LITERAL_ROUTES = new Set(["/login", "/signup", "/portal"]);'));
  assert(src.includes('const PUBLIC_PREFIX_ROUTES = ["/invite/", "/portal/"];'));
});

Deno.test("support hook: Sidebar and PortalLayout read supportNavItems", async () => {
  const sidebar = await read("web/src/components/Sidebar.svelte");
  assert(sidebar.includes('import { supportNavItems } from "../features/support";'));
  assert(sidebar.includes("...supportNavItems"));
  const portal = await read("web/src/components/PortalLayout.svelte");
  assert(portal.includes('import { supportNavItems } from "../features/support";'));
  assert(portal.includes("{#each supportNavItems as item"));
});

Deno.test("support hook: app.ts mounts the support router at /api/support", async () => {
  const src = await read("app.ts");
  assert(src.includes('import { supportRouter } from "@/services/support/router.ts";'));
  assert(src.includes('app.route("/api/support", supportRouter);'));
  assert(typeof supportRouter.fetch === "function");
});

Deno.test("support hook: the base router answers 404 on every support path", async () => {
  const src = await read("src/services/support/router.ts");
  if (!src.includes(BASE_MARKER)) return; // pack installed
  const app = new Hono();
  app.route("/api/support", supportRouter);
  for (const [method, path] of [["GET", "/api/support/config"], ["POST", "/api/support/requests"]]) {
    const res = await app.request(path, { method });
    assertEquals(res.status, 404, `${method} ${path}`);
    await res.body?.cancel();
  }
});

Deno.test("support hook: agent-tools/index.ts imports the support tools module", async () => {
  const src = await read("src/services/agent-tools/index.ts");
  assert(src.includes('import "@/services/support/agent-tools.ts";'));
  const stub = await read("src/services/support/agent-tools.ts");
  if (!stub.includes(BASE_MARKER)) return; // pack installed
  assert(!stub.includes("registerAgentTool"), "the base stub registers no tools");
});
