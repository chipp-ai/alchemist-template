#!/usr/bin/env bash
#
# Idempotently apply the tenant context-switch guard to an existing
# customer-project clone of this template. Customer projects don't track
# this template as a git remote (each is provisioned as its own GitHub
# repo), so this script copies the new files and patches the touched
# existing files in place, guarded by sentinels so a re-run is a no-op.
#
# The bug class this closes: pages fetch tenant-scoped data in onMount and
# nothing remounts them when the tenant changes, so an org / workspace /
# account switcher (or a logout then sign-in) leaves the previous tenant's
# data on screen. See CLAUDE.md -> "Tenant and route context".
#
# Usage:
#   scripts/apply-context-switch-to-clones.sh <target-project-dir>
#   scripts/apply-context-switch-to-clones.sh --all   # walks ~/.alchemist/projects/*
#
# What it does:
#   * Copies 4 new files from this template into the target:
#       web/src/lib/context-switch.svelte.ts
#       .claude/rules/frontend-state.md
#       src/__tests__/routes/context-switch-remount-lint.test.ts
#       src/__tests__/context-switch-guidance.test.ts
#   * Idempotently patches 6 existing files:
#       web/src/App.svelte                   (import, routerKey, {#key} around both <Router>, signed-out branch)
#       web/src/lib/query.svelte.ts          (resetQueries)
#       web/src/stores/auth.svelte.ts        (logout fires runContextSwitch)
#       web/src/stores/organization.svelte.ts (registers its reset)
#       web/src/lib/view-transitions-dom.ts  (skipped-transition rejections handled)
#       CLAUDE.md                            (hub section, spoke table row, pitfalls tripwire)
#
# CLAUDE.md IS patched here, unlike the observability retrofit: the prompt
# guidance is the point of this change. Every insertion is anchored and
# sentinel-guarded; a customer CLAUDE.md that lost an anchor gets a [warn]
# and the rest still applies.
#
# Failure mode: a code patch whose anchor is gone reports [fail] and exits
# non-zero, so a half-applied guard is never silently left behind.

set -euo pipefail

TEMPLATE_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

ok()    { printf "  [ok]   %s\n" "$1"; }
skip()  { printf "  [skip] %s\n" "$1"; }
warn()  { printf "  [warn] %s\n" "$1" >&2; }
fail()  { printf "  [fail] %s\n" "$1" >&2; exit 1; }

copy_new_files() {
  local target="$1"
  for rel in \
      "web/src/lib/context-switch.svelte.ts" \
      ".claude/rules/frontend-state.md" \
      "src/__tests__/routes/context-switch-remount-lint.test.ts" \
      "src/__tests__/context-switch-guidance.test.ts"
  do
    mkdir -p "$(dirname "$target/$rel")"
    cp "$TEMPLATE_ROOT/$rel" "$target/$rel"
    ok "copy $rel"
  done
}

# Replace exactly one occurrence of OLD with NEW in FILE. SENTINEL present
# in the file means the patch already applied. Anchored + guarded so a
# re-run is a no-op and a missing anchor is loud.
replace_once() {
  local file="$1" sentinel="$2" old="$3" new="$4" label="$5"
  if [ ! -f "$file" ]; then fail "missing $file"; fi
  if grep -qF -- "$sentinel" "$file"; then
    skip "$label already applied"
    return
  fi
  OLD="$old" NEW="$new" python3 - "$file" "$label" <<'PY'
import os, sys
path, label = sys.argv[1], sys.argv[2]
old, new = os.environ["OLD"], os.environ["NEW"]
src = open(path).read()
n = src.count(old)
if n != 1:
    print(f"ERR: {label}: expected exactly one anchor match in {path}, found {n}", file=sys.stderr)
    sys.exit(1)
open(path, "w").write(src.replace(old, new))
PY
  ok "$label"
}

patch_app_svelte() {
  local f="$1/web/src/App.svelte"
  replace_once "$f" 'import { contextSwitch }' \
'  import { authStore } from "./stores/auth.svelte";
' \
'  import { authStore } from "./stores/auth.svelte";
  import { contextSwitch } from "./lib/context-switch.svelte";
' "App.svelte: import contextSwitch"

  replace_once "$f" 'const routerKey = $derived' \
'  const showLayout = $derived(
    !authStore.isLoading && authStore.isAuthenticated && !onPublicRoute && !onPortalRoute,
  );
</script>
' \
'  const showLayout = $derived(
    !authStore.isLoading && authStore.isAuthenticated && !onPublicRoute && !onPortalRoute,
  );

  // Router key: the routed page mounts fresh whenever the tenant context
  // changes (contextSwitch.epoch, bumped by runContextSwitch() on an
  // org / workspace / account switch and on logout) or the path changes
  // ($location, so /things/A -> /things/B remounts the detail page
  // instead of leaving it on A'"'"'s data). Pages fetch in onMount and rely
  // on THIS to re-run; never add a per-page org-id watch instead. See
  // web/src/lib/context-switch.svelte.ts and CLAUDE.md -> "Tenant and
  // route context". Both <Router> mounts below must stay inside the key.
  const routerKey = $derived(`${contextSwitch.epoch}:${$location}`);
</script>
' "App.svelte: routerKey"

  replace_once "$f" '{#key routerKey}' \
'    <main class="app-main">
      <Router {routes} />
    </main>
  </div>
{:else}
  <Router {routes} />
{/if}' \
'    <main class="app-main">
      {#key routerKey}
        <Router {routes} />
      {/key}
    </main>
  </div>
{:else if onPublicRoute || onPortalRoute || authStore.isAuthenticated}
  {#key routerKey}
    <Router {routes} />
  {/key}
{:else}
  <!-- Signed out on a protected path: the redirect effect above is already
       moving us to /login. Rendering nothing here (instead of mounting the
       protected page for one frame) keeps its onMount loaders from firing
       against a session that no longer exists, which is what a logout
       from /settings used to do: three 401s and an aborted view
       transition in the console for every sign-out. -->
{/if}' "App.svelte: key both routers + signed-out branch"
}

patch_query() {
  local f="$1/web/src/lib/query.svelte.ts"
  replace_once "$f" 'export function resetQueries' \
'export function invalidateQueries(prefix: string): void {
  for (const [key, entry] of CACHE) {
    if (!key.startsWith(prefix)) continue;
    entry.state.updatedAt = 0;
    if (isActive(entry)) void revalidate(entry);
  }
}
' \
'export function invalidateQueries(prefix: string): void {
  for (const [key, entry] of CACHE) {
    if (!key.startsWith(prefix)) continue;
    entry.state.updatedAt = 0;
    if (isActive(entry)) void revalidate(entry);
  }
}

/**
 * Drop every cached result (data AND error) and refetch the active ones.
 * Called by `runContextSwitch()` (web/src/lib/context-switch.svelte.ts)
 * when the tenant changes or the user signs out: query keys carry no
 * tenant id, so a cached `shipments:list` from the previous organization
 * would otherwise be served, instantly and wrong, to the next one. Unlike
 * `invalidateQueries`, this does not keep stale data on screen while the
 * refetch runs; there is no "stale" version of another tenant'"'"'s data.
 */
export function resetQueries(): void {
  for (const entry of CACHE.values()) {
    entry.state.data = undefined;
    entry.state.error = null;
    entry.state.updatedAt = 0;
    if (isActive(entry)) void revalidate(entry);
  }
}
' "query.svelte.ts: resetQueries"
}

patch_auth() {
  local f="$1/web/src/stores/auth.svelte.ts"
  replace_once "$f" 'import { runContextSwitch }' \
'import { defineStore } from "../lib/devpanel/store.svelte";
' \
'import { defineStore } from "../lib/devpanel/store.svelte";
import { runContextSwitch } from "../lib/context-switch.svelte";
' "auth.svelte.ts: import runContextSwitch"
  replace_once "$f" 'runContextSwitch();' \
'  state.user = null;
  window.location.hash = redirectTo;
}' \
'  state.user = null;
  // Signing out is a context switch: clear every tenant-scoped store and
  // the query cache so the next sign-in (same SPA lifetime, maybe another
  // user or organization) never sees this session'"'"'s data.
  runContextSwitch();
  window.location.hash = redirectTo;
}' "auth.svelte.ts: logout fires runContextSwitch"
}

patch_org() {
  local f="$1/web/src/stores/organization.svelte.ts"
  replace_once "$f" 'import { registerContextReset }' \
'import { defineStore } from "../lib/devpanel/store.svelte";
' \
'import { defineStore } from "../lib/devpanel/store.svelte";
import { registerContextReset } from "../lib/context-switch.svelte";
' "organization.svelte.ts: import registerContextReset"
  replace_once "$f" 'registerContextReset(reset);' \
'function reset(): void {
  state.currentOrg = null;
  state.members = [];
  state.pendingInvites = [];
  state.isLoading = false;
  state.error = null;
}
' \
'function reset(): void {
  state.currentOrg = null;
  state.members = [];
  state.pendingInvites = [];
  state.isLoading = false;
  state.error = null;
}

// Tenant-scoped: cleared on every context switch (org switch, logout) so a
// remounted page never reads the previous organization out of this store.
registerContextReset(reset);
' "organization.svelte.ts: register reset"
}

patch_view_transitions() {
  local f="$1/web/src/lib/view-transitions-dom.ts"
  if [ ! -f "$f" ]; then warn "no view-transitions-dom.ts (older clone), skipping"; return; fi
  replace_once "$f" 'transition.ready.catch' \
'  (document as unknown as { startViewTransition: (cb: () => void) => void }).startViewTransition(update);
}' \
'  const transition = (document as unknown as {
    startViewTransition: (cb: () => void) => { ready: Promise<void>; finished: Promise<void> };
  }).startViewTransition(update);

  // A transition that gets skipped (a second navigation lands mid-fade, the
  // tab is hidden, the routed tree remounts under it) rejects `ready` with
  // InvalidStateError. That is the browser saying "no cross-fade this
  // time", not a failure: `update()` already ran. Without these handlers
  // every skipped fade surfaces as an unhandled promise rejection in the
  // console (seen on logout, which navigates twice: the auth effect and
  // the logout redirect).
  transition.ready.catch(() => {});
  transition.finished.catch(() => {});
}' "view-transitions-dom.ts: handle skipped transitions"
}

# CLAUDE.md: three anchored insertions. A missing anchor warns instead of
# failing (customer hubs drift); the section is copied verbatim from this
# template so the guidance test passes in the clone afterwards.
patch_claude_md() {
  local f="$1/CLAUDE.md"
  if [ ! -f "$f" ]; then warn "no CLAUDE.md, skipping prompt guidance"; return; fi
  CLAUDE_SRC="$TEMPLATE_ROOT/CLAUDE.md" python3 - "$f" <<'PY'
import os, re, sys
path = sys.argv[1]
tpl = open(os.environ["CLAUDE_SRC"]).read()
src = open(path).read()

def warn(msg): print(f"  [warn] {msg}", file=sys.stderr)
def ok(msg): print(f"  [ok]   {msg}")
def skip(msg): print(f"  [skip] {msg}")

# 1. Hub section, copied verbatim from the template (heading .. before "### Routing").
sec_start = tpl.index("### Tenant and route context: the Router key, not per-page watches")
sec_end = tpl.index("### Routing", sec_start)
section = tpl[sec_start:sec_end]
if "### Tenant and route context" in src:
    skip("CLAUDE.md: hub section already present")
elif "### Routing" in src:
    src = src.replace("### Routing", section + "### Routing", 1)
    ok("CLAUDE.md: hub section inserted before '### Routing'")
else:
    warn("CLAUDE.md: no '### Routing' anchor; append the 'Tenant and route context' section by hand")

# 2. Spoke table row.
row = "| `frontend-state.md` | `web/src/App.svelte`, `web/src/routes/**`, `web/src/stores/**`, `query.svelte.ts`, `context-switch.svelte.ts` | Page lifetime and tenant context: the Router key, `runContextSwitch()`, store resets, the switcher checklist |\n"
if "| `frontend-state.md` |" in src:
    skip("CLAUDE.md: spoke table row already present")
else:
    m = re.search(r"^\| `design\.md` \|.*\n", src, re.M)
    if m:
        src = src[:m.end()] + row + src[m.end():]
        ok("CLAUDE.md: spoke table row added")
    else:
        warn("CLAUDE.md: no '| `design.md` |' table row; add the frontend-state.md row by hand")

# 3. Common Pitfalls tripwire.
bullet = "- **A tenant switch (org / workspace / account) or logout must call `runContextSwitch()` AFTER the server confirms, and every `<Router>` stays inside the `routerKey` `{#key}` in `App.svelte`** -- pages fetch in `onMount` and rely on the remount; a per-page org-id watch is the wrong fix (see \"Tenant and route context\")\n"
if "must call `runContextSwitch()` AFTER the server confirms" in src:
    skip("CLAUDE.md: pitfalls tripwire already present")
else:
    m = re.search(r"^- \*\*SPA error redirects use `replace\(\)`, not `push\(\)`\*\*.*\n", src, re.M)
    if m:
        src = src[:m.end()] + bullet + src[m.end():]
        ok("CLAUDE.md: pitfalls tripwire added")
    else:
        warn("CLAUDE.md: no 'SPA error redirects' pitfall anchor; add the tripwire bullet by hand")

open(path, "w").write(src)
PY
}

apply_to() {
  local target="$1"
  if [ ! -d "$target" ]; then fail "target not a directory: $target"; fi
  if [ ! -f "$target/app.ts" ] || [ ! -d "$target/web" ]; then
    warn "$target doesn't look like a template clone (missing app.ts or web/), skipping"
    return
  fi
  if [ ! -f "$target/web/src/lib/query.svelte.ts" ]; then
    warn "$target predates the createQuery layer; apply that retrofit first, skipping"
    return
  fi
  printf "\n-> %s\n" "$target"
  copy_new_files "$target"
  patch_app_svelte "$target"
  patch_query "$target"
  patch_auth "$target"
  patch_org "$target"
  patch_view_transitions "$target"
  patch_claude_md "$target"
  printf "  next: cd %s && deno test --no-check --allow-all src/__tests__/routes/context-switch-remount-lint.test.ts src/__tests__/context-switch-guidance.test.ts && (cd web && npm run build)\n" "$target"
}

if [ $# -lt 1 ]; then
  printf "usage: %s <target-dir>\n       %s --all\n" "$0" "$0" >&2
  exit 1
fi

if [ "$1" = "--all" ]; then
  for dir in ~/.alchemist/projects/*/; do
    apply_to "${dir%/}"
  done
else
  apply_to "$1"
fi

printf "\nDone.\n"
