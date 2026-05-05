/**
 * App state snapshot — what the dev panel ships to the server and
 * what the agent reads via `GET /api/dev/app-state`.
 *
 * This module is pure (no Svelte reactivity, no DOM mutation, no
 * fetch). It just gathers the runtime state at a moment in time and
 * returns it as a structured object + a markdown rendering.
 *
 * Pipeline:
 *
 *   stores → getStoreSnapshots()
 *      ↓
 *   collectClientSnapshot()  ← also adds route, viewport, errors
 *      ↓
 *   formatSnapshotAsMarkdown()  ← human-readable for agent + DevPanel
 *      ↓
 *   POST /api/dev/app-state  (push.svelte.ts)
 *
 * The server merges this with its own context (recent API requests,
 * recent server errors, DB/Redis health) and serves the combined
 * picture from `GET /api/dev/app-state`.
 */

import { getStoreSnapshots, listStoreNames } from "./store.svelte";
import { getRecentClientErrors } from "./errors";

export interface ClientSnapshot {
  timestamp: string;
  route: {
    hash: string;
    path: string;
    /** Path-derived params we can extract without a router instance. */
    params: Record<string, string>;
  };
  viewport: { width: number; height: number };
  /** Every store registered via defineStore, by name. */
  stores: Record<string, unknown>;
  /** Last N client-side errors captured by `lib/devpanel/errors`. */
  recentErrors: Array<{
    timestamp: string;
    message: string;
    stack?: string;
    source?: string;
  }>;
  /** Names of registered stores, in registration order. UI uses this for stable display. */
  storeOrder: string[];
}

const DEPLOY_ENV = (import.meta.env.MODE ?? "development").toString();

/**
 * Extract route params from common path patterns. Customer apps
 * inevitably end up with /apps/:id, /projects/:slug, /dashboard,
 * /settings/:tab — we cover the regulars without requiring a router
 * dependency. If a customer's app has bespoke patterns the agent
 * needs to see, they can add them via `extractCustomRouteParams`
 * (see CLAUDE.md → DevPanel customization).
 */
function extractRouteParams(path: string): Record<string, string> {
  const params: Record<string, string> = {};

  const apps = path.match(/\/apps?\/([^/]+)/);
  if (apps) params.appId = apps[1];

  const projects = path.match(/\/projects?\/([^/]+)/);
  if (projects) params.projectId = projects[1];

  const settings = path.match(/\/settings\/([^/]+)/);
  if (settings) params.settingsTab = settings[1];

  const id = path.match(/\/([^/]+)\/([0-9a-f-]{36})\b/);
  if (id) params[`${id[1]}Id`] = id[2];

  return params;
}

/**
 * Snapshot the running app's client state. Safe to call from any
 * context — never throws on individual subsystem errors (snapshot
 * helpers internally swallow + report errors).
 */
export function collectClientSnapshot(): ClientSnapshot {
  const hash = (typeof location !== "undefined" ? location.hash : "") || "#/";
  const pathMatch = hash.match(/#([^?]*)/);
  const path = pathMatch ? pathMatch[1] : "/";

  return {
    timestamp: new Date().toISOString(),
    route: {
      hash,
      path,
      params: extractRouteParams(path),
    },
    viewport: {
      width: typeof window !== "undefined" ? window.innerWidth : 0,
      height: typeof window !== "undefined" ? window.innerHeight : 0,
    },
    stores: getStoreSnapshots(),
    recentErrors: getRecentClientErrors(),
    storeOrder: listStoreNames(),
  };
}

/**
 * Render a snapshot as Markdown for human + agent consumption. Same
 * shape used by chipp-deno's dev panel — agents get the most signal
 * from headed sections + a JSON dump for the precise values.
 */
export function formatSnapshotAsMarkdown(snapshot: ClientSnapshot): string {
  const lines: string[] = [
    "# Client App State Snapshot",
    "",
    `**Timestamp:** ${snapshot.timestamp}`,
    `**Mode:** ${DEPLOY_ENV}`,
    "",
    "## Route",
    "",
    `- **Path:** \`${snapshot.route.path}\``,
    `- **Hash:** \`${snapshot.route.hash}\``,
  ];

  if (Object.keys(snapshot.route.params).length > 0) {
    lines.push("- **Params:**");
    for (const [k, v] of Object.entries(snapshot.route.params)) {
      lines.push(`  - ${k}: \`${v}\``);
    }
  }

  lines.push(
    "",
    "## Viewport",
    "",
    `- **Size:** ${snapshot.viewport.width}x${snapshot.viewport.height}`,
    "",
    `## Stores (${snapshot.storeOrder.length})`,
    "",
  );

  if (snapshot.storeOrder.length === 0) {
    lines.push(
      "_No stores registered via `defineStore`. If this app uses bare " +
        "module-level `$state` for shared state, the dev panel can't see it — " +
        "migrate to `defineStore` (see `web/src/lib/devpanel/store.svelte.ts`)._",
    );
  } else {
    for (const name of snapshot.storeOrder) {
      lines.push(`### \`${name}\``);
      lines.push("");
      lines.push("```json");
      lines.push(JSON.stringify(snapshot.stores[name], null, 2));
      lines.push("```");
      lines.push("");
    }
  }

  if (snapshot.recentErrors.length > 0) {
    lines.push(
      `## Recent Client Errors (${snapshot.recentErrors.length})`,
      "",
    );
    for (const err of snapshot.recentErrors) {
      lines.push(`- **${err.timestamp}** [${err.source ?? "unknown"}]`);
      lines.push(`  ${err.message}`);
      if (err.stack) {
        lines.push("  ```");
        for (const stackLine of err.stack.split("\n").slice(0, 5)) {
          lines.push(`  ${stackLine}`);
        }
        lines.push("  ```");
      }
    }
    lines.push("");
  }

  return lines.join("\n");
}
