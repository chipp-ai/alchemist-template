/**
 * Server half of the Svelte islands runtime. Part of the SSR kernel
 * (`.claude/rules/ssr.md`). The client half is `web/src/islands/entry.ts`,
 * a separate Vite entry that mounts every `web/src/islands/*.svelte`.
 *
 * - `renderIsland(name, props, fallbackHtml)` emits the marker a page
 *   renders for one island: `<div data-island="Name" data-props="...">`
 *   around the server-rendered no-JS fallback.
 * - `islandsScriptTag()` is the tag a page includes once to load the
 *   runtime. Production reads the hashed file name from
 *   `web/dist/.vite/manifest.json`; dev (the fail-closed
 *   `devRoutesEnabled()` flag) points at the Vite dev server.
 *
 * Progressive enhancement is the contract. A missing or malformed manifest
 * is not fatal: `islandsScriptTag()` logs one warning and returns "", and
 * every page must still work with no script at all.
 */

import { log } from "@/lib/logger.ts";
import { devRoutesEnabled } from "@/lib/dev-mode.ts";
import { escapeHtml } from "./render-html.ts";
import { safeJsonAttr } from "./safe-json.ts";
import { getEnv } from "@/lib/env.ts";

/**
 * The islands entry's path relative to the Vite root. Vite uses exactly
 * this string as the manifest key. Must match the `islands` input in
 * `web/vite.config.ts`.
 */
export const ISLANDS_ENTRY_SRC = "src/islands/entry.ts";

const DEFAULT_DEV_SERVER_URL = "http://localhost:5173";

interface ManifestChunk {
  file?: unknown;
  css?: unknown;
}

/**
 * The `<link>`/`<script>` tags for the islands entry, from the TEXT of the
 * Vite manifest, or null when it has no usable entry. Never throws.
 */
export function resolveIslandsTagFromManifestJson(manifestJsonText: string): string | null {
  let manifest: unknown;
  try {
    manifest = JSON.parse(manifestJsonText);
  } catch {
    return null;
  }
  if (manifest === null || typeof manifest !== "object") return null;
  const chunk = (manifest as Record<string, ManifestChunk>)[ISLANDS_ENTRY_SRC];
  if (!chunk || typeof chunk.file !== "string" || chunk.file.length === 0) return null;

  const css = Array.isArray(chunk.css) ? chunk.css : [];
  const links = css
    .filter((href): href is string => typeof href === "string" && href.length > 0)
    .map((href) => `<link rel="stylesheet" href="/${escapeHtml(href)}" />`);
  return [...links, `<script type="module" src="/${escapeHtml(chunk.file)}"></script>`].join("\n");
}

// `undefined` = not resolved yet; `null` = resolved to "no usable tag".
let cachedProdTag: string | null | undefined;
let manifestPathOverride: string | URL | null = null;

function manifestPath(): string | URL {
  return manifestPathOverride ?? new URL("../../../web/dist/.vite/manifest.json", import.meta.url);
}

function devScriptTag(): string {
  const base = (getEnv("VITE_DEV_SERVER_URL") ?? DEFAULT_DEV_SERVER_URL).replace(/\/+$/, "");
  return `<script type="module" src="${escapeHtml(base)}/@vite/client"></script>\n` +
    `<script type="module" src="${escapeHtml(base)}/${ISLANDS_ENTRY_SRC}"></script>`;
}

function resolveProdTag(): string {
  if (cachedProdTag !== undefined) return cachedProdTag ?? "";
  let text: string;
  try {
    text = Deno.readTextFileSync(manifestPath());
  } catch (err) {
    // Expected in a checkout that has not run the web build yet. In
    // production the image always builds web/dist, so a miss is a bug.
    const logFn = getEnv("NODE_ENV") === "production" ? log.error : log.warn;
    logFn(
      "Islands manifest missing; pages render without the islands script. Run the web build.",
      { source: "ssr", feature: "islands" },
      err instanceof Error ? err : new Error(String(err)),
    );
    cachedProdTag = null;
    return "";
  }
  const tag = resolveIslandsTagFromManifestJson(text);
  if (tag === null) {
    // A built manifest with no islands entry is a build misconfiguration.
    log.error("Islands manifest has no islands entry chunk; pages render without it", {
      source: "ssr",
      feature: "islands",
      entry: ISLANDS_ENTRY_SRC,
    });
  }
  cachedProdTag = tag;
  return tag ?? "";
}

/** The tag(s) that load the islands runtime. Include once per page. Never throws. */
export function islandsScriptTag(): string {
  return devRoutesEnabled() ? devScriptTag() : resolveProdTag();
}

/**
 * The production tag, from the built manifest, whatever the dev flag says.
 * Exported for tests: they must not flip ALCHEMIST_DEV_ROUTES, because
 * parallel test files share one process environment.
 */
export function prodIslandsScriptTag(): string {
  return resolveProdTag();
}

/**
 * The marker for one island. `fallbackHtml` is already-escaped markup (the
 * no-JS view), not text; this function does not escape it. `props` goes
 * through `safeJsonAttr`, and is untrusted on the client side too.
 */
export function renderIsland(
  name: string,
  props: Record<string, unknown> = {},
  fallbackHtml = "",
): string {
  return `<div data-island="${escapeHtml(name)}" data-props="${safeJsonAttr(props)}">${fallbackHtml}</div>`;
}

/** Test seam: read the manifest from `path` (null restores the real one) and clear the cache. */
export function __setIslandsManifestPathForTests(path: string | URL | null): void {
  manifestPathOverride = path;
  cachedProdTag = undefined;
}
