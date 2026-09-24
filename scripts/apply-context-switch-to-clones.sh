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
#       web/src/lib/context-switch.svelte.ts   (query import stripped when the clone has no query layer)
#       .claude/rules/frontend-state.md
#       src/__tests__/routes/context-switch-remount-lint.test.ts
#       src/__tests__/context-switch-guidance.test.ts
#   * Idempotently patches up to 6 existing files:
#       web/src/App.svelte                    (import, routerKey, {#key} around both <Router>, signed-out branch)
#       web/src/lib/query.svelte.ts           (generation guard + resetQueries; skipped when absent)
#       web/src/stores/auth.svelte.ts         (logout fires runContextSwitch)
#       web/src/stores/organization.svelte.ts (registers its reset)
#       web/src/lib/view-transitions-dom.ts   (skipped-transition rejections handled; skipped when absent)
#       CLAUDE.md                             (hub section, spoke table row, pitfalls tripwire)
#
# Every patch is SHAPE-tolerant, not text-exact: clones drift (a cockpit
# shell instead of the portal lane, extra state cleared in logout, an
# invalidateQueries with a throttle field, a hub without a spoke table).
# The 2026-09-24 fleet dry run over 123 clones is where each fallback here
# came from. A code patch whose anchor is truly gone reports [fail] and
# exits non-zero, so a half-applied guard is never silently left behind;
# CLAUDE.md fallbacks append rather than fail, because a customer hub may
# have been restructured.

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
  if [ ! -f "$target/web/src/lib/query.svelte.ts" ]; then
    # Pre-createQuery clone: there is no cache to reset. Strip the import and
    # the call so the module loads; the store resets and the epoch still work.
    python3 - "$target/web/src/lib/context-switch.svelte.ts" <<'PY'
import sys
path = sys.argv[1]
src = open(path).read()
src = src.replace('import { resetQueries } from "./query.svelte";\n\n', "")
src = src.replace("  resetQueries();\n", "  // (no createQuery layer in this project: nothing to reset here)\n")
open(path, "w").write(src)
PY
    ok "context-switch.svelte.ts: query-layer import stripped (clone predates createQuery)"
  fi
}

patch_app_svelte() {
  local f="$1/web/src/App.svelte"
  if [ ! -f "$f" ]; then fail "missing $f"; fi
  python3 - "$f" <<'PY'
import re, sys
path = sys.argv[1]
src = open(path).read()
def ok(m): print(f"  [ok]   App.svelte: {m}")
def skip(m): print(f"  [skip] App.svelte: {m}")
def fail(m): print(f"ERR: App.svelte: {m}", file=sys.stderr); sys.exit(1)

# 1. import
if "import { contextSwitch }" in src:
    skip("import already present")
else:
    m = re.search(r'^(\s*)import \{ authStore \} from "\./stores/auth\.svelte";\n', src, re.M)
    if not m: fail("no authStore import to anchor on")
    src = src[:m.end()] + m.group(1) + 'import { contextSwitch } from "./lib/context-switch.svelte";\n' + src[m.end():]
    ok("import contextSwitch")

# 2. routerKey, right before the first </script>
if "const routerKey = $derived" in src:
    skip("routerKey already present")
else:
    block = """
  // Router key: the routed page mounts fresh whenever the tenant context
  // changes (contextSwitch.epoch, bumped by runContextSwitch() on an
  // org / workspace / account switch and on logout) or the path changes
  // ($location, so /things/A -> /things/B remounts the detail page
  // instead of leaving it on A's data). Pages fetch in onMount and rely
  // on THIS to re-run; never add a per-page org-id watch instead. See
  // web/src/lib/context-switch.svelte.ts and CLAUDE.md -> "Tenant and
  // route context". Both <Router> mounts below must stay inside the key.
  const routerKey = $derived(`${contextSwitch.epoch}:${$location}`);
</script>
"""
    i = src.find("</script>\n")
    if i == -1: fail("no </script>")
    if "$location" not in src[:i]:
        fail("App.svelte does not import `location` from svelte-spa-router; add it before retrofitting")
    src = src[:i].rstrip("\n") + "\n" + block + src[i + len("</script>\n"):]
    ok("routerKey")

# 3. key every <Router {routes} /> line, keeping its indent
if "{#key routerKey}" in src:
    skip("routers already keyed")
else:
    out, keyed = [], 0
    for line in src.split("\n"):
        m = re.match(r"^(\s*)(<Router\b[^>]*/>)\s*$", line)
        if m:
            ind, tag = m.group(1), m.group(2)
            out += [f"{ind}{{#key routerKey}}", f"{ind}  {tag}", f"{ind}{{/key}}"]
            keyed += 1
        else:
            out.append(line)
    if keyed < 2: fail(f"expected at least two single-line `<Router ... />` mounts, found {keyed}")
    src = "\n".join(out)
    ok(f"keyed {keyed} <Router> mounts")

# 4. signed-out branch around the bare (last) Router
if "Signed out on a protected path" in src:
    skip("signed-out branch already present")
else:
    def warn(m): print(f"  [warn] App.svelte: {m}", file=sys.stderr)
    if "const onPublicRoute" in src: pub = "onPublicRoute"
    elif re.search(r"const isPublicRoute = \$derived\(", src): pub = "isPublicRoute"
    elif re.search(r"import routes, \{[^}]*\bisPublicRoute\b", src): pub = "isPublicRoute($location)"
    elif re.search(r"import routes, \{[^}]*\bpublicRoutes\b", src): pub = "publicRoutes.has($location)"
    else: pub = None
    if pub is None:
        # A custom shell (own admin / public / auth-form branches). The guard
        # (routerKey on every Router) is in place; the signed-out branch only
        # avoids a one-frame mount of a protected page after logout.
        warn("custom shell without a public-route predicate; signed-out branch skipped (routers are keyed, the guard holds)")
        open(path, "w").write(src)
        sys.exit(0)
    terms = [pub]
    if "const onPortalRoute" in src: terms.append("onPortalRoute")
    terms.append("authStore.isAuthenticated")
    cond = " || ".join(terms)

    lines = src.split("\n")
    last_key = max(i for i, l in enumerate(lines) if l.strip() == "{#key routerKey}")
    # nearest {:else} above the bare Router, with no other branch marker between
    else_i = None
    for i in range(last_key - 1, -1, -1):
        s = lines[i].strip()
        if s == "{:else}":
            else_i = i; break
        if s.startswith("{:else if") or s.startswith("{#if") or s == "{/if}":
            break
    if else_i is None:
        warn("no bare {:else} branch around the last <Router> (custom shell); signed-out branch skipped (routers are keyed, the guard holds)")
        open(path, "w").write(src)
        sys.exit(0)
    ind = lines[else_i][: len(lines[else_i]) - len(lines[else_i].lstrip())]
    lines[else_i] = f"{ind}{{:else if {cond}}}"
    # the {/if} that closes that branch: first {/if} after the bare Router's {/key}
    close_key = next(i for i in range(last_key, len(lines)) if lines[i].strip() == "{/key}")
    endif_i = next((i for i in range(close_key, len(lines)) if lines[i].strip() == "{/if}"), None)
    if endif_i is None: fail("no {/if} after the bare Router")
    branch = [
        f"{ind}{{:else}}",
        f"{ind}  <!-- Signed out on a protected path: the redirect effect above is already",
        f"{ind}       moving us to /login. Rendering nothing here (instead of mounting the",
        f"{ind}       protected page for one frame) keeps its onMount loaders from firing",
        f"{ind}       against a session that no longer exists, which is what a logout",
        f"{ind}       from /settings used to do: three 401s and an aborted view",
        f"{ind}       transition in the console for every sign-out. -->",
    ]
    lines[endif_i:endif_i] = branch
    src = "\n".join(lines)
    ok(f"signed-out branch (condition: {cond})")

open(path, "w").write(src)
PY
}

patch_query() {
  local f="$1/web/src/lib/query.svelte.ts"
  if [ ! -f "$f" ]; then skip "query.svelte.ts: no createQuery layer in this clone"; return; fi
  python3 - "$f" <<'PY'
import re, sys
path = sys.argv[1]
src = open(path).read()
def ok(m): print(f"  [ok]   query.svelte.ts: {m}")
def skip(m): print(f"  [skip] query.svelte.ts: {m}")
def fail(m): print(f"ERR: query.svelte.ts: {m}", file=sys.stderr); sys.exit(1)
def fn_span(name):
    i = src.find(name)
    if i == -1: return None
    j = src.find("\n}\n", i)
    return (i, j + 3)

# 1. QueryEntry.gen
if "gen: number;" in src:
    skip("QueryEntry.gen already present")
else:
    a = "  inFlight: Promise<void> | null;\n"
    if src.count(a) != 1: fail("QueryEntry.inFlight field not found once")
    src = src.replace(a, a +
        "  /** Bumped by resetQueries(); a fetch started under an older generation\n"
        "   *  discards its result so a previous tenant's response can never land. */\n"
        "  gen: number;\n")
    ok("QueryEntry.gen")

# 2. revalidate() generation guard, by shape
if "const gen = entry.gen;" in src:
    skip("revalidate() guard already present")
else:
    span = fn_span("function revalidate<T>(")
    if not span: fail("no revalidate<T>() function")
    body = src[span[0]:span[1]]
    a = "  entry.state.isFetching = true;\n"
    if body.count(a) != 1: fail("revalidate() has no single `entry.state.isFetching = true;` to anchor the generation on")
    body = body.replace(a, "  const gen = entry.gen;\n" + a)
    for opener, guard in [
        (".then((data) => {\n", "      if (gen !== entry.gen) return; // reset happened mid-flight: stale tenant\n"),
        (".catch((err) => {\n", "      if (gen !== entry.gen) return;\n"),
        (".finally(() => {\n", "      if (gen !== entry.gen) return; // the reset already cleared these\n"),
    ]:
        if body.count(opener) != 1: fail(f"revalidate() has no single `{opener.strip()}` block")
        body = body.replace(opener, opener + guard)
    src = src[:span[0]] + body + src[span[1]:]
    ok("revalidate() generation guard")

# 3. entry literal
if re.search(r"^\s+gen: 0,\n", src, re.M):
    skip("entry literal gen already present")
else:
    m = re.search(r"^(\s+)inFlight: null,\n", src, re.M)
    if not m: fail("createQuery entry literal has no `inFlight: null,`")
    src = src[:m.end()] + m.group(1) + "gen: 0,\n" + src[m.end():]
    ok("entry literal gen: 0")

# 4. resetQueries: insert after invalidateQueries, or upgrade the first cut
extra = "    entry.lastAttemptAt = 0;\n" if "lastAttemptAt" in src else ""
NEW = """/**
 * Drop every cached result (data AND error) without refetching anything.
 * Called by `runContextSwitch()` (web/src/lib/context-switch.svelte.ts)
 * when the tenant changes or the user signs out: query keys carry no
 * tenant id, so a cached `shipments:list` from the previous organization
 * would otherwise be served, instantly and wrong, to the next one.
 *
 * Three deliberate differences from `invalidateQueries`:
 *   - nothing is refetched here: on logout there is no session to fetch
 *     with (every active query would 401), and on a tenant switch the
 *     remounted page's first read triggers the fetch anyway;
 *   - `lastReadAt` drops to 0 so the poll interval and the window-focus
 *     handler treat the entry as inactive until a remounted page reads it;
 *   - `gen` is bumped and `inFlight` cleared so a fetch that started under
 *     the previous tenant discards its result instead of landing late.
 */
export function resetQueries(): void {
  for (const entry of CACHE.values()) {
    entry.gen += 1;
    entry.inFlight = null;
    entry.lastReadAt = 0;
""" + extra + """    entry.state.data = undefined;
    entry.state.error = null;
    entry.state.updatedAt = 0;
    entry.state.isFetching = false;
  }
}
"""
if "export function resetQueries" not in src:
    span = fn_span("export function invalidateQueries(")
    if not span: fail("no invalidateQueries() to anchor resetQueries after")
    src = src[:span[1]] + "\n" + NEW + src[span[1]:]
    ok("resetQueries inserted")
elif "entry.gen += 1;" in src:
    skip("resetQueries already the clear-only version")
else:
    # first cut (refetched active entries): replace the whole function + its doc comment
    fi = src.find("export function resetQueries")
    doc = src.rfind("/**", 0, fi)
    fe = src.find("\n}\n", fi) + 3
    if doc == -1 or src.find("*/", doc, fi) == -1: doc = fi
    src = src[:doc] + NEW + src[fe:]
    ok("resetQueries upgraded from the refetching first cut")

open(path, "w").write(src)
PY
}

patch_auth() {
  local f="$1/web/src/stores/auth.svelte.ts"
  if [ ! -f "$f" ]; then fail "missing $f"; fi
  python3 - "$f" <<'PY'
import re, sys
path = sys.argv[1]
src = open(path).read()
def ok(m): print(f"  [ok]   auth.svelte.ts: {m}")
def skip(m): print(f"  [skip] auth.svelte.ts: {m}")
def fail(m): print(f"ERR: auth.svelte.ts: {m}", file=sys.stderr); sys.exit(1)

if "import { runContextSwitch }" in src:
    skip("import already present")
else:
    a = 'import { defineStore } from "../lib/devpanel/store.svelte";\n'
    line = 'import { runContextSwitch } from "../lib/context-switch.svelte";\n'
    if src.count(a) == 1:
        src = src.replace(a, a + line)
    else:
        imports = list(re.finditer(r"^import .*;\n", src, re.M))
        if not imports: fail("no import lines to anchor on")
        e = imports[-1].end()
        src = src[:e] + line + src[e:]
    ok("import runContextSwitch")

if "runContextSwitch();" in src:
    skip("logout already fires runContextSwitch")
else:
    i = src.find("async function logout(")
    if i == -1: i = src.find("function logout(")
    if i == -1: fail("no logout() function")
    j = src.find("\n}\n", i)
    body = src[i:j]
    if not re.search(r"^\s*(state\.)?user = null;", body, re.M): fail("logout() does not clear the user; patch by hand")
    hook = """  // Signing out is a context switch: clear every tenant-scoped store and
  // the query cache so the next sign-in (same SPA lifetime, maybe another
  // user or organization) never sees this session's data.
  runContextSwitch();
"""
    m = list(re.finditer(r"^\s*window\.location\.hash = .*$", body, re.M))
    if m:
        k = m[-1].start()
        body = body[:k] + hook + body[k:]
    else:
        body = body + "\n" + hook.rstrip("\n")
    src = src[:i] + body + src[j:]
    ok("logout fires runContextSwitch")

open(path, "w").write(src)
PY
}

patch_org() {
  local f="$1/web/src/stores/organization.svelte.ts"
  if [ ! -f "$f" ]; then warn "no organization.svelte.ts; register resets for your tenant-scoped stores by hand"; return; fi
  python3 - "$f" <<'PY'
import re, sys
path = sys.argv[1]
src = open(path).read()
def ok(m): print(f"  [ok]   organization.svelte.ts: {m}")
def skip(m): print(f"  [skip] organization.svelte.ts: {m}")
def warn(m): print(f"  [warn] organization.svelte.ts: {m}", file=sys.stderr)

if "registerContextReset(" in src:
    skip("reset already registered")
    sys.exit(0)
i = src.find("function reset(): void {")
if i == -1:
    warn("no reset() function; register a reset for this store by hand")
    sys.exit(0)
a = 'import { defineStore } from "../lib/devpanel/store.svelte";\n'
line = 'import { registerContextReset } from "../lib/context-switch.svelte";\n'
if src.count(a) == 1:
    src = src.replace(a, a + line)
else:
    imports = list(re.finditer(r"^import .*;\n", src, re.M))
    e = imports[-1].end() if imports else 0
    src = src[:e] + line + src[e:]
ok("import registerContextReset")
i = src.find("function reset(): void {")
j = src.find("\n}\n", i) + 3
src = src[:j] + """
// Tenant-scoped: cleared on every context switch (org switch, logout) so a
// remounted page never reads the previous organization out of this store.
registerContextReset(reset);
""" + src[j:]
ok("register reset")
open(path, "w").write(src)
PY
}

patch_view_transitions() {
  local f="$1/web/src/lib/view-transitions-dom.ts"
  if [ ! -f "$f" ]; then warn "no view-transitions-dom.ts (older clone), skipping"; return; fi
  if grep -qF 'transition.ready.catch' "$f"; then skip "view-transitions-dom.ts: already handled"; return; fi
  python3 - "$f" <<'PY'
import sys
path = sys.argv[1]
src = open(path).read()
old = "  (document as unknown as { startViewTransition: (cb: () => void) => void }).startViewTransition(update);\n}"
new = """  const transition = (document as unknown as {
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
}"""
if src.count(old) != 1:
    print("  [warn] view-transitions-dom.ts: startViewTransition call has an unexpected shape; handle `ready`/`finished` rejections by hand", file=sys.stderr)
    sys.exit(0)
open(path, "w").write(src.replace(old, new))
print("  [ok]   view-transitions-dom.ts: handle skipped transitions")
PY
}

patch_claude_md() {
  local f="$1/CLAUDE.md"
  if [ ! -f "$f" ]; then warn "no CLAUDE.md, skipping prompt guidance"; return; fi
  CLAUDE_SRC="$TEMPLATE_ROOT/CLAUDE.md" python3 - "$f" <<'PY'
import os, re, sys
path = sys.argv[1]
tpl = open(os.environ["CLAUDE_SRC"]).read()
src = open(path).read()
def warn(m): print(f"  [warn] {m}", file=sys.stderr)
def ok(m): print(f"  [ok]   {m}")
def skip(m): print(f"  [skip] {m}")
if not src.endswith("\n"): src += "\n"

# 1. Hub section, verbatim from the template.
sec_start = tpl.index("### Tenant and route context: the Router key, not per-page watches")
section = tpl[sec_start:tpl.index("### Routing", sec_start)]
if "### Tenant and route context" in src:
    skip("CLAUDE.md: hub section already present")
elif "### Routing" in src:
    src = src.replace("### Routing", section + "### Routing", 1)
    ok("CLAUDE.md: hub section inserted before '### Routing'")
else:
    src += "\n## Frontend: tenant and route context\n\n" + section
    ok("CLAUDE.md: hub section appended (no '### Routing' anchor)")

# 2. Spoke table row.
row = "| `frontend-state.md` | `web/src/App.svelte`, `web/src/routes/**`, `web/src/stores/**`, `query.svelte.ts`, `context-switch.svelte.ts` | Page lifetime and tenant context: the Router key, `runContextSwitch()`, store resets, the switcher checklist |\n"
if "| `frontend-state.md` |" in src:
    skip("CLAUDE.md: spoke table row already present")
else:
    m = re.search(r"^\| `design\.md` \|.*\n", src, re.M)
    h = re.search(r"^\| Spoke \|.*\n\|[-| ]+\n", src, re.M)
    if m:
        src = src[:m.end()] + row + src[m.end():]
        ok("CLAUDE.md: spoke table row added")
    elif h:
        end = h.end()
        for line in src[end:].split("\n"):
            if not line.startswith("|"): break
            end += len(line) + 1
        src = src[:end] + row + src[end:]
        ok("CLAUDE.md: spoke table row added (after the last spoke row)")
    else:
        src += ("\n## Convention spokes - `.claude/rules/`\n\n"
                "Area-specific conventions live in `.claude/rules/<name>.md`, each scoped to a\n"
                "path glob via `paths:` frontmatter. A spoke loads only when you work in its area.\n\n"
                "| Spoke | Auto-loads when you touch | Covers |\n|---|---|---|\n" + row)
        ok("CLAUDE.md: spoke table created with the frontend-state.md row (no table existed)")

# 3. Common Pitfalls tripwire.
bullet = "- **A tenant switch (org / workspace / account) or logout must call `runContextSwitch()` AFTER the server confirms, and every `<Router>` stays inside the `routerKey` `{#key}` in `App.svelte`** -- pages fetch in `onMount` and rely on the remount; a per-page org-id watch is the wrong fix (see \"Tenant and route context\")\n"
if "must call `runContextSwitch()` AFTER the server confirms" in src:
    skip("CLAUDE.md: pitfalls tripwire already present")
else:
    m = re.search(r"^- \*\*SPA error redirects use `replace\(\)`, not `push\(\)`\*\*.*\n", src, re.M)
    h = re.search(r"^## Common Pitfalls\s*\n", src, re.M)
    if m:
        src = src[:m.end()] + bullet + src[m.end():]
        ok("CLAUDE.md: pitfalls tripwire added")
    elif h:
        # first bullet under the heading
        b = re.compile(r"^- ", re.M).search(src, h.end())
        at = b.start() if b else h.end()
        src = src[:at] + bullet + src[at:]
        ok("CLAUDE.md: pitfalls tripwire added under '## Common Pitfalls'")
    else:
        src += "\n## Common Pitfalls\n\n" + bullet
        ok("CLAUDE.md: '## Common Pitfalls' created with the tripwire")

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
  if [ ! -f "$target/web/src/App.svelte" ] || [ ! -f "$target/web/src/stores/auth.svelte.ts" ]; then
    warn "$target has no web/src/App.svelte or auth store, skipping"
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
