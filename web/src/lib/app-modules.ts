/**
 * Which built-in sections this app keeps (web/src/chipp-app.json).
 *
 * The Chipp Builder writes chipp-app.json when the person approves a plan:
 * the planner decides which built-in sections the app needs, and a section
 * that is off loses its sidebar link and its routes. Turn a section on or off
 * by editing chipp-app.json, never by editing the sidebar or the route table.
 *
 * Pure (no JSON import) so it can be tested under Deno; app-config.ts feeds
 * it the real file.
 */

export const APP_MODULES = ["inboundEmail", "import", "fileReview", "docs", "portal"] as const;
export type AppModule = typeof APP_MODULES[number];

export interface ChippAppConfig {
  version?: number;
  modules?: Partial<Record<AppModule, boolean>>;
}

/** On unless the config turns it off: a missing file or key keeps today's behavior. */
export function isModuleOn(config: ChippAppConfig | null | undefined, module: AppModule): boolean {
  return config?.modules?.[module] !== false;
}

/** The routes each module owns (paths as in web/src/routes.ts). */
export const MODULE_ROUTES: Record<AppModule, readonly string[]> = {
  inboundEmail: ["/inbound-emails", "/inbound-emails/:id"],
  import: ["/import"],
  fileReview: ["/files/review"],
  docs: ["/docs", "/docs/:slug"],
  portal: ["/portal", "/portal/claim/:token"],
};

/** `routes` without the routes of modules that are off. */
export function withoutOffModules<T>(config: ChippAppConfig | null | undefined, routes: Record<string, T>): Record<string, T> {
  const off = new Set(APP_MODULES.filter((m) => !isModuleOn(config, m)).flatMap((m) => MODULE_ROUTES[m]));
  return Object.fromEntries(Object.entries(routes).filter(([path]) => !off.has(path)));
}
