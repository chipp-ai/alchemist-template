/**
 * Mobile shell (source-shape test, no browser).
 *
 * Below 768px the 240px sidebar left a phone about 130px of page. The
 * shell now shows a top bar with a menu button and turns the sidebar into
 * a drawer; App.svelte gives the page the full width. This pins the pieces
 * so a later edit cannot quietly bring the side column back on phones.
 */
import { assert } from "@std/assert";

const read = (rel: string) => Deno.readTextFile(new URL("../../" + rel, import.meta.url));

Deno.test("mobile shell: Sidebar.svelte has a top bar, a menu button and a drawer under 768px", async () => {
  const src = await read("web/src/components/Sidebar.svelte");
  assert(src.includes('data-testid="sidebar-btn-menu"'));
  assert(src.includes('data-testid="sidebar-backdrop"'));
  assert(src.includes("class:open={menuOpen}"));
  assert(/@media \(max-width: 768px\)[\s\S]*\.sidebar \{[\s\S]*position: fixed/.test(src));
  assert(/void \$location;\s*menuOpen = false;/.test(src), "navigation closes the drawer");
});

Deno.test("mobile shell: App.svelte gives the page the full width under 768px", async () => {
  const src = await read("web/src/App.svelte");
  assert(/@media \(max-width: 768px\)[\s\S]*\.app-layout \{\s*display: block;/.test(src));
  assert(src.includes("padding: calc(56px + var(--space-md))"));
});
