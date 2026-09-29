/**
 * Islands runtime: the client half. Part of the SSR kernel (see
 * `.claude/rules/ssr.md`); the server half is `src/services/ssr/islands.ts`.
 *
 * Scans a server-rendered page for `data-island="<Name>"` markers and mounts
 * `web/src/islands/<Name>.svelte` in place, with props from the marker's
 * `data-props` JSON.
 *
 * ADDING AN ISLAND: create `web/src/islands/<Name>.svelte`. That is all.
 * `import.meta.glob` below finds every island at build time, so a recipe
 * pack adds islands without editing this file. Each island is its own
 * chunk, and a page with no islands loads only this small entry.
 *
 * Progressive enhancement is the contract: every page works with this
 * script never loading. An unknown name, bad `data-props` JSON or a mount
 * failure skips THAT island only, with a console message.
 *
 * This is a separate Vite entry from `web/src/main.ts` (the SPA). It must
 * never import main.ts, App.svelte or the stores
 * (`src/__tests__/services/islands-entry-map.test.ts` checks the sources).
 */
import { mount, type Component } from "svelte";
import { installBreadcrumbs } from "../lib/observability/breadcrumbs";

installBreadcrumbs();

type IslandModule = { default: Component<Record<string, unknown>> };

/** Island name -> loader, from every `./<Name>.svelte` next to this file. */
export const ISLAND_MAP: Record<string, () => Promise<IslandModule>> = Object.fromEntries(
  Object.entries(import.meta.glob<IslandModule>("./*.svelte")).map(([path, load]) => [
    path.slice(2, -".svelte".length),
    load,
  ]),
);

/** `data-props` for one island, or null (never throws) when it is not a JSON object. */
function parseIslandProps(el: Element, name: string): Record<string, unknown> | null {
  const raw = el.getAttribute("data-props");
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    console.warn(`[islands] data-props for "${name}" is not an object; skipping`);
    return null;
  } catch (err) {
    console.error(`[islands] malformed data-props for "${name}"; skipping`, {
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

async function mountIsland(el: Element): Promise<void> {
  const name = el.getAttribute("data-island");
  if (!name) return;
  // Own-property check: "constructor" or "__proto__" must not resolve.
  const load = Object.hasOwn(ISLAND_MAP, name) ? ISLAND_MAP[name] : undefined;
  if (!load) {
    console.warn(`[islands] unknown island "${name}"; skipping`);
    return;
  }
  const props = parseIslandProps(el, name);
  if (props === null) return;
  try {
    const mod = await load();
    // mount() appends; clear the no-JS fallback first.
    el.innerHTML = "";
    mount(mod.default, { target: el, props });
  } catch (err) {
    console.error(`[islands] failed to mount "${name}"`, {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/** Mounts every `[data-island]` marker on the page. One failure never blocks the rest. */
export function mountAllIslands(): void {
  for (const el of document.querySelectorAll("[data-island]")) void mountIsland(el);
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", mountAllIslands);
} else {
  mountAllIslands();
}
