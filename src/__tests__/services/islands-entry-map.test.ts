/**
 * Islands runtime, client half (web/src/islands/). Source-shape checks, since
 * the entry runs in the browser:
 *
 * - entry.ts discovers islands with import.meta.glob, so a pack adds an
 *   island by adding a .svelte file and never edits entry.ts;
 * - no island file imports the SPA (main.ts, App.svelte, stores, routes),
 *   which would pull the whole SPA into public pages;
 * - the Vite config builds the entry the server-side manifest lookup expects.
 */

import { assert, assertStringIncludes } from "@std/assert";
import { ISLANDS_ENTRY_SRC } from "@/services/ssr/islands.ts";

const WEB = new URL("../../../web/", import.meta.url);
const ISLANDS_DIR = new URL("src/islands/", WEB);

Deno.test("entry.ts discovers every island with import.meta.glob", async () => {
  const entry = await Deno.readTextFile(new URL("entry.ts", ISLANDS_DIR));
  assertStringIncludes(entry, 'import.meta.glob<IslandModule>("./*.svelte")');
  assert(!/import\("\.\/\w+\.svelte"\)/.test(entry), "islands are discovered, never listed by hand");
});

Deno.test("no island file imports the SPA", async () => {
  const banned = /from\s+["'](?:\.\.\/(?:main|App\.svelte|stores\/|routes\/)|\$lib\/(?:api|query))/;
  for await (const f of Deno.readDir(ISLANDS_DIR)) {
    if (!f.isFile || !/\.(ts|svelte)$/.test(f.name)) continue;
    const src = await Deno.readTextFile(new URL(f.name, ISLANDS_DIR));
    assert(!banned.test(src), `web/src/islands/${f.name} imports the SPA`);
  }
});

Deno.test("vite builds the islands entry with a manifest", async () => {
  const config = await Deno.readTextFile(new URL("vite.config.ts", WEB));
  assertStringIncludes(config, "manifest: true");
  assertStringIncludes(config, `"./${ISLANDS_ENTRY_SRC}"`);
});
