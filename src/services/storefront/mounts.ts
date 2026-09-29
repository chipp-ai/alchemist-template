/**
 * Route-module discovery for the public storefront router. Part of the SSR
 * kernel (`.claude/rules/ssr.md`).
 *
 * A recipe pack adds a public page by adding ONE file:
 * `src/services/storefront/<name>.routes.ts`, whose default export is a Hono
 * router with absolute paths (`router.get("/products/:slug", ...)`). The
 * router in `./router.ts` finds every such file at boot and mounts it at
 * "/". No pack edits a shared file to register a route, so installing a
 * storefront pack into an existing project only ADDS files.
 *
 * Modules mount in file-name order. Routes must not overlap across
 * modules, and middleware must be path-scoped (`router.use("/cart/*", mw)`),
 * never `use("*")`, because every module shares the "/" mount.
 */

import type { Hono } from "hono";

/** The file-name suffix that marks a route module. */
export const ROUTE_MODULE_SUFFIX = ".routes.ts";

/** Loads one module spec (for example `./landing.routes.ts`). */
export type RouteModuleImporter = (spec: string) => Promise<unknown>;

/**
 * The route modules in `dir`, as sorted `./<name>.routes.ts` specs. Not
 * recursive: helpers and services next to them are never mounted. A missing
 * directory is an empty list.
 */
export async function discoverRouteModules(dir: URL): Promise<string[]> {
  const specs: string[] = [];
  try {
    for await (const entry of Deno.readDir(dir)) {
      if (entry.isFile && entry.name.endsWith(ROUTE_MODULE_SUFFIX)) specs.push(`./${entry.name}`);
    }
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) return [];
    throw err;
  }
  return specs.sort();
}

function isHonoRouter(value: unknown): value is Hono {
  return typeof value === "object" && value !== null &&
    typeof (value as { fetch?: unknown }).fetch === "function" &&
    Array.isArray((value as { routes?: unknown }).routes);
}

/**
 * Imports each spec and mounts its default export on `app` at "/". Throws
 * when a module has no router as its default export: a route module that
 * cannot mount is a build error, and the app must not boot without it.
 * Returns the mounted specs.
 */
export async function mountPublicRoutes(
  app: Hono<any, any, any>,
  specs: readonly string[],
  importer: RouteModuleImporter,
): Promise<string[]> {
  const mounted: string[] = [];
  for (const spec of specs) {
    const mod = await importer(spec) as { default?: unknown };
    if (!isHonoRouter(mod?.default)) {
      throw new Error(
        `storefront route module ${spec} must default-export a Hono router (export default router)`,
      );
    }
    app.route("/", mod.default);
    mounted.push(spec);
  }
  return mounted;
}
