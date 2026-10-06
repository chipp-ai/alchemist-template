/**
 * web/src/chipp-app.json switches built-in sections off (Chipp Builder writes
 * it when a plan is approved). A section that is off loses its routes and
 * its sidebar link; a missing file or key keeps the section on.
 */
import { assert, assertEquals } from "@std/assert";
import { APP_MODULES, isModuleOn, MODULE_ROUTES, withoutOffModules } from "../../../web/src/lib/app-modules.ts";

const routes = { "/": 1, "/import": 2, "/inbound-emails": 3, "/inbound-emails/:id": 4, "/docs": 5, "*": 9 };

Deno.test("app modules: on unless switched off", () => {
  assertEquals(isModuleOn(null, "import"), true);
  assertEquals(isModuleOn({ modules: {} }, "import"), true);
  assertEquals(isModuleOn({ modules: { import: false } }, "import"), false);
});

Deno.test("app modules: an off module's routes go, the rest keep their order", () => {
  const kept = withoutOffModules({ modules: { inboundEmail: false } }, routes);
  assertEquals(Object.keys(kept), ["/", "/import", "/docs", "*"]);
  assertEquals(withoutOffModules(null, routes), routes);
});

Deno.test("app modules: the shipped chipp-app.json names every module, all on", async () => {
  const shipped = JSON.parse(await Deno.readTextFile(new URL("../../../web/src/chipp-app.json", import.meta.url)));
  assertEquals(Object.keys(shipped.modules).sort(), [...APP_MODULES].sort());
  assert(APP_MODULES.every((m) => shipped.modules[m] === true));
  assert(APP_MODULES.every((m) => MODULE_ROUTES[m].length > 0));
});

Deno.test("app modules: the sidebar and the route table read the switches", async () => {
  const sidebar = await Deno.readTextFile(new URL("../../../web/src/components/Sidebar.svelte", import.meta.url));
  const table = await Deno.readTextFile(new URL("../../../web/src/routes.ts", import.meta.url));
  for (const m of ["inboundEmail", "import", "fileReview"]) assert(sidebar.includes(`moduleOn("${m}")`), m);
  assert(table.includes("withoutOffModules(appConfig, allRoutes)"));
});
