/**
 * web/src/lib/app-name.ts: the app's own name reaches the SPA as
 * `<meta name="app-name">`, and the sidebar falls back to it.
 *
 * Why: the sidebar showed a literal "App" for a user with no organization,
 * which is every Builder preview's dev user (Chipp bug 47).
 */

import { assert, assertEquals } from "@std/assert";
import { appNameMetaTag, readAppName } from "../../web/src/lib/app-name.ts";

const fakeDoc = (content: string | null) => ({
  querySelector: (sel: string) =>
    sel === 'meta[name="app-name"]' && content !== null ? { getAttribute: () => content } : null,
});

Deno.test("appNameMetaTag escapes the name and is empty without one", () => {
  assertEquals(appNameMetaTag("Launchwell"), '<meta name="app-name" content="Launchwell" />');
  assertEquals(
    appNameMetaTag(`Joe's "Best" <Pizza> & Co`),
    '<meta name="app-name" content="Joe&#39;s &quot;Best&quot; &lt;Pizza&gt; &amp; Co" />',
  );
  assertEquals(appNameMetaTag("   "), "");
  assertEquals(appNameMetaTag(undefined), "");
});

Deno.test("readAppName reads the tag, and is null when there is none", () => {
  assertEquals(readAppName(fakeDoc(" Launchwell ")), "Launchwell");
  assertEquals(readAppName(fakeDoc("")), null);
  assertEquals(readAppName(fakeDoc(null)), null);
  assertEquals(readAppName(undefined), null);
});

Deno.test("the sidebar falls back to the app name before the literal App", async () => {
  const src = await Deno.readTextFile(new URL("../../web/src/components/Sidebar.svelte", import.meta.url));
  assert(src.includes('orgStore.currentOrg?.name ?? appName ?? "App"'));
  assertEquals(src.includes('orgStore.currentOrg?.name ?? "App"'), false);
});

Deno.test("vite injects the tag from APP_NAME", async () => {
  const src = await Deno.readTextFile(new URL("../../web/vite.config.ts", import.meta.url));
  assert(src.includes("appNameMetaTag(process.env.APP_NAME)"));
});
