/**
 * Context-switch remount lint (source-shape test, no DB, no browser).
 *
 * The bug class this guards: a page fetches tenant-scoped data once in
 * `onMount`; a global switcher (organization, workspace, account) or a
 * logout does not navigate, so the page stays mounted and keeps showing
 * the PREVIOUS tenant's data. Chipp shipped it on its billing page
 * (2026-09-24). The template closes the class in one place, and this test
 * pins every part of that place:
 *
 *   A. `web/src/App.svelte` renders every `<Router>` inside a `{#key}`
 *      whose expression carries both `contextSwitch.epoch` and `$location`.
 *   B. `web/src/lib/context-switch.svelte.ts` exports `contextSwitch`
 *      (reactive `epoch`), `registerContextReset` and `runContextSwitch`,
 *      and `runContextSwitch` runs the resets, then `resetQueries()`, then
 *      bumps the epoch, in that order.
 *   C. `web/src/lib/query.svelte.ts` exports `resetQueries`.
 *   D. `authStore.logout()` calls `runContextSwitch()`.
 *   E. The organization store registers its reset.
 *   F. No page under `web/src/routes/` keys a refetch on an org id inside
 *      `$effect` (the wrong fix that a same-org switch defeats).
 *
 * See CLAUDE.md -> "Tenant and route context" and
 * `.claude/rules/frontend-state.md`.
 */
import { assert, assertEquals } from "@std/assert";

const WEB_SRC = new URL("../../../web/src/", import.meta.url);
const read = (rel: string) => Deno.readTextFile(new URL(rel, WEB_SRC));

Deno.test("context switch: every <Router> in App.svelte sits inside the routerKey {#key}", async () => {
  const src = await read("App.svelte");

  assert(
    /const routerKey = \$derived\(`\$\{contextSwitch\.epoch\}:\$\{\$location\}`\)/.test(src),
    "App.svelte must derive routerKey from contextSwitch.epoch AND $location",
  );
  assert(
    /import \{ contextSwitch \} from "\.\/lib\/context-switch\.svelte"/.test(src),
    "App.svelte must import contextSwitch",
  );

  // Markup only: everything after </script>, with HTML comments blanked so
  // a comment that mentions <Router> cannot trip the scan.
  const scriptEnd = src.indexOf("</script>");
  assert(scriptEnd !== -1, "App.svelte must have a <script> block");
  const markup = src.slice(scriptEnd).replace(/<!--[\s\S]*?-->/g, (c) => " ".repeat(c.length));

  const ranges: Array<[number, number]> = [];
  const openRe = /\{#key routerKey\}/g;
  let m: RegExpExecArray | null;
  while ((m = openRe.exec(markup)) !== null) {
    const close = markup.indexOf("{/key}", m.index);
    assert(close !== -1, `unclosed {#key routerKey} at offset ${m.index}`);
    ranges.push([m.index, close]);
  }
  assert(ranges.length > 0, "App.svelte has no {#key routerKey} block");

  const routerRe = /<Router\b/g;
  const outside: number[] = [];
  let seen = 0;
  while ((m = routerRe.exec(markup)) !== null) {
    seen++;
    const pos = m.index;
    if (!ranges.some(([a, b]) => pos > a && pos < b)) outside.push(pos);
  }
  assert(seen >= 2, `expected the authed and unauthed <Router> mounts, found ${seen}`);
  assertEquals(
    outside,
    [],
    `<Router> rendered outside {#key routerKey} at offsets ${outside.join(", ")}: a tenant switch would leave that page on the previous tenant's data`,
  );
});

Deno.test("context switch: the module exports the signal and orders reset -> query reset -> epoch bump", async () => {
  const src = await read("lib/context-switch.svelte.ts");
  assert(/export const contextSwitch = \{/.test(src), "must export contextSwitch");
  assert(/get epoch\(\): number/.test(src), "contextSwitch must expose a reactive epoch getter");
  assert(/export function registerContextReset\(/.test(src), "must export registerContextReset");
  assert(/export function runContextSwitch\(\): void/.test(src), "must export runContextSwitch");
  assert(/import \{ resetQueries \} from "\.\/query\.svelte"/.test(src), "must import resetQueries");

  const fnStart = src.indexOf("export function runContextSwitch");
  const body = src.slice(fnStart);
  const loopAt = body.indexOf("for (const fn of resets)");
  const queriesAt = body.indexOf("resetQueries();");
  const bumpAt = body.indexOf("epoch += 1;");
  assert(loopAt !== -1 && queriesAt !== -1 && bumpAt !== -1, "runContextSwitch must run resets, resetQueries() and bump the epoch");
  assert(loopAt < queriesAt && queriesAt < bumpAt, "order must be: store resets, then resetQueries(), then the epoch bump (the bump is what remounts; nothing stale may survive it)");
});

Deno.test("context switch: the query layer can drop its whole cache", async () => {
  const src = await read("lib/query.svelte.ts");
  assert(/export function resetQueries\(\): void/.test(src), "query.svelte.ts must export resetQueries");
  const fnStart = src.indexOf("export function resetQueries");
  const body = src.slice(fnStart, src.indexOf("\n}\n", fnStart) + 3);
  for (const needle of ["entry.gen += 1;", "entry.inFlight = null;", "entry.lastReadAt = 0;", "entry.state.data = undefined;", "entry.state.error = null;", "entry.state.updatedAt = 0;"]) {
    assert(body.includes(needle), `resetQueries must include '${needle}'`);
  }
  assert(!/revalidate\(/.test(body), "resetQueries must NOT refetch: on logout there is no session (every active query would 401); the remounted page's first read fetches");
  assert(/const gen = entry\.gen;/.test(src) && /if \(gen !== entry\.gen\) return;/.test(src), "revalidate() must discard a result whose generation predates a reset");
});

Deno.test("context switch: logout fires it, and the organization store registers its reset", async () => {
  const auth = await read("stores/auth.svelte.ts");
  const logoutStart = auth.indexOf("async function logout(");
  assert(logoutStart !== -1, "auth store must define logout()");
  const logoutBody = auth.slice(logoutStart, auth.indexOf("\n}", logoutStart));
  assert(logoutBody.includes("runContextSwitch();"), "logout() must call runContextSwitch() so the next sign-in never sees this session's data");

  const org = await read("stores/organization.svelte.ts");
  assert(/registerContextReset\(reset\);/.test(org), "organization store must register its reset with the context switch");
});

Deno.test("context switch: no page keys a refetch on an org id inside $effect", async () => {
  const offenders: string[] = [];
  for await (const rel of walkSvelte(new URL("routes/", WEB_SRC), "routes/")) {
    const text = await read(rel);
    // An $effect whose body reads an org/workspace id AND calls a loader is
    // the per-page watch this template forbids; the Router key already
    // remounts the page on every switch.
    const effectRe = /\$effect\(\s*\(\)\s*=>\s*\{([\s\S]*?)\n\s*\}\s*\);/g;
    let m: RegExpExecArray | null;
    while ((m = effectRe.exec(text)) !== null) {
      const body = m[1];
      const readsTenantId = /(currentOrg\?*\.id|organizationId|workspaceId|tenantId)/.test(body);
      const callsLoader = /\b(fetch[A-Z]\w*|load[A-Z]?\w*|refetch|api\.get)\s*\(/.test(body);
      if (readsTenantId && callsLoader) offenders.push(rel);
    }
  }
  assertEquals(offenders, [], `these pages watch a tenant id to refetch; delete the watch, the Router key remounts the page on every switch: ${offenders.join(", ")}`);
});

async function* walkSvelte(dir: URL, prefix: string): AsyncGenerator<string> {
  for await (const entry of Deno.readDir(dir)) {
    const rel = `${prefix}${entry.name}`;
    if (entry.isDirectory) {
      yield* walkSvelte(new URL(`${entry.name}/`, dir), `${rel}/`);
    } else if (entry.name.endsWith(".svelte")) {
      yield rel;
    }
  }
}
