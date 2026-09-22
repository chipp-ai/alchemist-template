#!/usr/bin/env bash
#
# Idempotently apply the design-system changes (template 11fdd8c) to an
# existing customer-project clone of this template. Customer projects
# don't track this template as a git remote (each is provisioned as its
# own GitHub repo), so this script copies the new design-system files
# and patches the touched existing files in place, guarded by sentinels
# so a re-run is a no-op.
#
# Scope note: a SEPARATE, larger design-system-program (S1-S4, cross-repo
# — dark mode, motion.css, the toast kit, the app.css guardrail lint,
# web/DESIGN.md; see docs/design-system-program.md) landed in this
# template independently of the design.json/presets/font-catalog/sheet
# system this script retrofits. This script does NOT carry that program
# forward into an old clone — it has its own S1p "port to variant repos"
# work item and its own cross-repo sequencing. Don't assume a
# retrofitted clone has dark mode / toasts / motion just because this
# script ran; check for web/DESIGN.md to know whether a given clone
# already has that separate slice.
#
# Usage:
#   scripts/apply-design-system-to-clones.sh <target-project-dir> [--preset <id>]
#   scripts/apply-design-system-to-clones.sh --all [--preset <id>]
#
# What it does:
#   • Copies 11 new files from this template into the target:
#       web/src/design/{apply,fonts,presets,tokens,types}.ts
#       web/src/design/design.json        (only if absent — user data, never clobbered)
#       web/src/routes/Design.svelte
#       src/services/design.service.ts
#       scripts/design.ts
#       docs/design-principles.md
#       .claude/rules/design.md
#   • Idempotently patches:
#       web/src/main.ts                   (applyDesign before mount)
#       web/src/routes.ts                 (/design route + dev-public)
#       web/src/components/Sidebar.svelte (dev nav item + palette icon)
#       web/index.html                    (remove static Google Fonts <link>,
#                                          keep preconnect; rewrite the stale
#                                          "two-file change" comment)
#       src/api/routes/dev/index.ts       (3 design routes + /info entries)
#       deno.json                         ("design" task)
#       web/src/app.css                   (ADDITIVE: template token block +
#                                          component classes appended under a
#                                          sentinel comment; customer custom
#                                          rules are left in place. Appended
#                                          rules win the cascade over both the
#                                          old template rules and any customer
#                                          rule that reuses a template class —
#                                          collisions are reported.)
#       CLAUDE.md                         (Typography section → Design system
#                                          section; design.md spoke row; 3 new
#                                          pitfalls. Prose-only: a missing
#                                          anchor WARNS but does not fail.)
#   • Flags every `font-family:` literal and hex colour in the target's
#     web/src/**/*.svelte for the follow-up hardcode ticket (DevPanel is
#     excluded — dev tooling with its own fixed dark theme).
#   • With --preset <id>: runs `deno task design apply <id>` in the target
#     afterwards so the clone doesn't ship template-default `clean`. The
#     per-project design step (match on the project description, preview on
#     /#/design) should still follow — see docs/design-principles.md § 7.
#
# Failure mode: any patch step that can't apply (because the target file
# was modified in a way that broke the anchor) is reported with a clear
# message and the script exits non-zero. Copied files always succeed;
# only the patches are anchor-sensitive.

set -euo pipefail

TEMPLATE_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# ── Helpers ────────────────────────────────────────────────────────

ok()    { printf "  [ok]   %s\n" "$1"; }
skip()  { printf "  [skip] %s\n" "$1"; }
warn()  { printf "  [warn] %s\n" "$1" >&2; }
fail()  { printf "  [fail] %s\n" "$1" >&2; exit 1; }

# ── Per-file applicators ───────────────────────────────────────────

copy_new_files() {
  local target="$1"
  for rel in \
      "web/src/design/apply.ts" \
      "web/src/design/design.json" \
      "web/src/design/fonts.ts" \
      "web/src/design/presets.ts" \
      "web/src/design/tokens.ts" \
      "web/src/design/types.ts" \
      "web/src/routes/Design.svelte" \
      "src/services/design.service.ts" \
      "scripts/design.ts" \
      "docs/design-principles.md" \
      ".claude/rules/design.md"
  do
    if [ "$rel" = "web/src/design/design.json" ] && [ -f "$target/$rel" ]; then
      # The project's chosen design is user data — never overwrite. A
      # re-run after the per-project design step must keep it.
      skip "$rel already exists (keeping the project's chosen design)"
      continue
    fi
    mkdir -p "$(dirname "$target/$rel")"
    cp "$TEMPLATE_ROOT/$rel" "$target/$rel"
    ok "copy $rel"
  done
}

patch_main_ts() {
  local file="$1/web/src/main.ts"
  if [ ! -f "$file" ]; then warn "missing $file"; return; fi
  if grep -q "applyDesign(" "$file"; then
    skip "web/src/main.ts already patched"
    return
  fi
  python3 - "$file" <<'PY'
import sys
path = sys.argv[1]
src = open(path).read()

addition = '''import { applyDesign } from "./design/apply";
import designJson from "./design/design.json";
import type { DesignConfig } from "./design/types";

// Apply the project's design system (fonts, palette, shape, type scale)
// before anything renders. web/src/design/design.json is the single
// source of truth; app.css only carries first-paint fallbacks. See
// CLAUDE.md → "Design system".
applyDesign(designJson as DesignConfig);

'''

lines = src.split("\n")
insert_at = None
# Primary anchor: the breadcrumbs import (observability-retrofitted clone).
# Fallback: the app.css import (pre-observability clone). Either way the
# block lands before mount.
for i, line in enumerate(lines):
    if line.startswith('import { installBreadcrumbs }'):
        insert_at = i + 1
        break
if insert_at is None:
    for i, line in enumerate(lines):
        if line.strip() == 'import "./app.css";':
            insert_at = i + 1
            break
if insert_at is None:
    print("ERR: web/src/main.ts has neither the breadcrumbs import nor 'import \"./app.css\";' — can't anchor applyDesign", file=sys.stderr)
    sys.exit(1)
out = "\n".join(lines[:insert_at]) + "\n" + addition + "\n".join(lines[insert_at:])
open(path, "w").write(out)
PY
  ok "patch web/src/main.ts"
}

patch_routes_ts() {
  local file="$1/web/src/routes.ts"
  if [ ! -f "$file" ]; then warn "missing $file"; return; fi
  if grep -q 'routes/Design.svelte' "$file"; then
    skip "web/src/routes.ts already patched"
    return
  fi
  python3 - "$file" <<'PY'
import sys, re
path = sys.argv[1]
src = open(path).read()
lines = src.split("\n")

# 1. Import after the LAST route import.
last_import = -1
for i, line in enumerate(lines):
    if re.search(r'from\s+"\./routes/', line):
        last_import = i
if last_import < 0:
    print('ERR: routes.ts has no "./routes/..." imports — can\'t anchor Design import', file=sys.stderr)
    sys.exit(1)
lines.insert(last_import + 1, 'import Design from "./routes/Design.svelte";')

# 2. Route entry after the /docs/:slug entry (same grouping as the template).
anchor2 = '"/docs/:slug": Docs,'
idx2 = next((i for i, l in enumerate(lines) if anchor2 in l), None)
if idx2 is None:
    print('ERR: routes.ts has no "/docs/:slug" entry — can\'t anchor /design route', file=sys.stderr)
    sys.exit(1)
block2 = '''  // Design system sheet: every component rendered with the live design
  // config + the controls to change it. Public in dev builds so the
  // platform's live preview can open it without a session; auth-gated
  // in production like any other internal page.
  "/design": Design,'''
lines[idx2 + 1:idx2 + 1] = block2.split("\n")

# 3. Dev-public check in isPublicRoute.
anchor3 = 'if (PUBLIC_LITERAL_ROUTES.has(path)) return true;'
idx3 = next((i for i, l in enumerate(lines) if anchor3 in l), None)
if idx3 is None:
    print("ERR: routes.ts has no PUBLIC_LITERAL_ROUTES check — can't anchor dev-public /design", file=sys.stderr)
    sys.exit(1)
lines.insert(idx3 + 1, '  if (import.meta.env.DEV && path === "/design") return true;')

open(path, "w").write("\n".join(lines))
PY
  ok "patch web/src/routes.ts"
}

patch_sidebar_svelte() {
  local file="$1/web/src/components/Sidebar.svelte"
  if [ ! -f "$file" ]; then warn "missing $file"; return; fi
  if grep -q 'path: "/design"' "$file"; then
    skip "Sidebar.svelte already patched"
    return
  fi
  python3 - "$file" <<'PY'
import sys
path = sys.argv[1]
src = open(path).read()
lines = src.split("\n")

# 1. Nav item after the /settings entry.
anchor1 = '{ path: "/settings", label: "Settings", icon: "settings" },'
idx1 = next((i for i, l in enumerate(lines) if anchor1 in l), None)
if idx1 is None:
    print("ERR: Sidebar.svelte has no /settings nav item — can't anchor Design nav item", file=sys.stderr)
    sys.exit(1)
block1 = '''    // Design system sheet — builder tooling, dev builds only.
    ...(import.meta.env.DEV ? [{ path: "/design", label: "Design", icon: "palette" }] : []),'''
lines[idx1 + 1:idx1 + 1] = block1.split("\n")

# 2. Palette icon at the top of the getIcon map.
anchor2 = 'const icons: Record<string, string> = {'
idx2 = next((i for i, l in enumerate(lines) if anchor2 in l), None)
if idx2 is None:
    print("ERR: Sidebar.svelte has no getIcon map — can't anchor palette icon", file=sys.stderr)
    sys.exit(1)
icon = """      palette:
        '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="13.5" cy="6.5" r="1.5"/><circle cx="17.5" cy="10.5" r="1.5"/><circle cx="8.5" cy="7.5" r="1.5"/><circle cx="6.5" cy="12.5" r="1.5"/><path d="M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10c.9 0 1.6-.7 1.6-1.6 0-.4-.2-.8-.4-1.1-.3-.3-.4-.7-.4-1.1 0-.9.7-1.6 1.6-1.6H16c3.3 0 6-2.7 6-6 0-4.9-4.5-8.6-10-8.6z"/></svg>',"""
lines[idx2 + 1:idx2 + 1] = icon.split("\n")

open(path, "w").write("\n".join(lines))
PY
  ok "patch Sidebar.svelte"
}

patch_index_html() {
  local file="$1/web/index.html"
  if [ ! -f "$file" ]; then warn "missing $file"; return; fi
  python3 - "$file" <<'PY'
import sys, re
path = sys.argv[1]
src = open(path).read()
changed = False

# 1. Drop every static Google Fonts stylesheet <link> (keep preconnects).
#    design.json → apply.ts now injects the one <link> the design needs.
for tag in re.findall(r'<link\b[^>]*>', src, flags=re.DOTALL):
    if 'fonts.googleapis.com/css2' in tag and 'rel="stylesheet"' in tag:
        src = src.replace(tag, '', 1)
        changed = True

# 2. Rewrite the old "TWO-FILE change" comment — that workflow is gone.
new_comment = '''    <!--
      Typography is driven by web/src/design/design.json (see CLAUDE.md
      → "Design system"). At boot web/src/design/apply.ts injects ONE
      Google Fonts <link> for exactly the families + weights the design
      names — do not add a static font <link> here. `preconnect` warms
      the TLS handshake for that request.
    -->'''
m = re.search(r'<!--\s*Typography: Google Fonts[\s\S]*?-->', src)
if m:
    src = src[:m.start()] + new_comment + src[m.end():]
    changed = True

if not changed:
    sys.exit(0)
open(path, "w").write(src)
PY
  if grep -q 'fonts.googleapis.com/css2' "$file"; then
    skip "web/index.html already has no static font link"
  else
    ok "patch web/index.html (static font link removed, preconnect kept)"
  fi
}

patch_dev_routes() {
  local file="$1/src/api/routes/dev/index.ts"
  if [ ! -f "$file" ]; then warn "missing $file"; return; fi
  if grep -q 'devRoutes.get("/design"' "$file"; then
    skip "dev/index.ts already patched"
    return
  fi
  # The route handlers use zValidator + validationHook + z + BadRequestError;
  # all are template-origin imports in this file. Verify before relying on them.
  for sym in zValidator validationHook "BadRequestError"; do
    if ! grep -q "$sym" "$file"; then
      fail "dev/index.ts does not import/use $sym — expected template-origin file"
    fi
  done
  python3 - "$file" <<'PY'
import sys, re
path = sys.argv[1]
src = open(path).read()
lines = src.split("\n")

# 1. Service import after the LAST @/services/ import.
last_import = -1
for i, line in enumerate(lines):
    if re.search(r'from\s+"@/services/', line):
        last_import = i
if last_import < 0:
    print("ERR: dev/index.ts has no @/services/ imports — can't anchor design.service import", file=sys.stderr)
    sys.exit(1)
import_block = '''import {
  applyDesignPreset,
  describeDesign,
  matchPresets,
  readDesign,
  writeDesign,
} from "@/services/design.service.ts";'''
lines[last_import + 1:last_import + 1] = import_block.split("\n")

# 2. The three design routes, before the snapshot section marker.
marker = "// ── POST /api/dev/snapshot ──"
idx = next((i for i, l in enumerate(lines) if marker in l), None)
if idx is None:
    print("ERR: dev/index.ts has no '── POST /api/dev/snapshot ──' marker — can't anchor design routes", file=sys.stderr)
    sys.exit(1)
routes_block = '''// ── Design system: GET/PUT /api/dev/design, POST /api/dev/design/preset ──
//
// The project's look lives in web/src/design/design.json. These routes are
// the validated read/write path for the /#/design page's "Save to project"
// and for the platform chat agent. GET returns the config plus its WCAG
// warnings, derived CSS tokens, every preset (with the vibe words that map
// to it) and the curated font catalog — enough for an orchestrator to
// build a swatch UI without knowing the file format.

devRoutes.get("/design", async (c) => {
  const design = await readDesign();
  const q = c.req.query("match");
  return c.json({
    data: {
      ...describeDesign(design),
      ...(q ? { matches: matchPresets(q).map((p) => p.id) } : {}),
    },
  });
});

devRoutes.put("/design", async (c) => {
  const body = await c.req.json().catch(() => {
    throw new BadRequestError("Body must be a design JSON object");
  });
  const result = await writeDesign(body);
  return c.json({ data: result });
});

const presetSchema = z.object({ preset: z.string().trim().min(1).max(64) });

devRoutes.post(
  "/design/preset",
  zValidator("json", presetSchema, validationHook),
  async (c) => {
    const { preset } = c.req.valid("json");
    const result = await applyDesignPreset(preset);
    return c.json({ data: result });
  },
);
'''
lines[idx:idx] = [""] + routes_block.split("\n")

# 3. /info entries, before the app-state entry.
anchor3 = '"POST /api/dev/app-state": {'
idx3 = next((i for i, l in enumerate(lines) if anchor3 in l), None)
if idx3 is None:
    print("ERR: dev/index.ts has no app-state /info entry — can't anchor design /info entries", file=sys.stderr)
    sys.exit(1)
info_block = '''      "GET /api/dev/design": {
        purpose:
          "Current design.json + WCAG warnings + derived CSS vars + presets + font catalog. " +
          "?match=<user words> ranks presets by vibe.",
      },
      "PUT /api/dev/design": {
        purpose: "Validate + write web/src/design/design.json. Body = DesignConfig.",
        returns: "{ data: { design, issues } }",
      },
      "POST /api/dev/design/preset": {
        body: { preset: "clean | modern | editorial | friendly | corporate | luxury | brutalist | dark | organic" },
        returns: "{ data: { design, issues } }",
      },'''
lines[idx3:idx3] = info_block.split("\n")

open(path, "w").write("\n".join(lines))
PY
  ok "patch src/api/routes/dev/index.ts"
}

patch_deno_json() {
  local file="$1/deno.json"
  if [ ! -f "$file" ]; then warn "missing $file"; return; fi
  if grep -q -- '--allow-write=web/src/design' "$file"; then
    skip "deno.json already patched"
    return
  fi
  python3 - "$file" <<'PY'
import sys, re
path = sys.argv[1]
src = open(path).read()
# JSONC: deno.json supports comments + trailing commas, so patch via regex
# on the db:migrate entry instead of round-tripping through json.
m = re.search(r'("db:migrate"\s*:\s*")([^"]*)(")', src)
if not m:
    print("ERR: deno.json has no db:migrate task — can't anchor design task", file=sys.stderr)
    sys.exit(1)
design_task = 'deno run --env --allow-env --allow-read --allow-write=web/src/design,.scratch/logs scripts/design.ts'
new_src = src[:m.end(3)] + ',\n    "design": "' + design_task + '"' + src[m.end(3):]
open(path, "w").write(new_src)
PY
  ok "patch deno.json (design task)"
}

patch_app_css() {
  local file="$1/web/src/app.css"
  if [ ! -f "$file" ]; then warn "missing $file"; return; fi
  if grep -q "design system tokens + components (template 11fdd8c)" "$file"; then
    skip "app.css already patched"
    return
  fi
  {
    printf '\n/* ── design system tokens + components (template 11fdd8c) ──\n'
    printf '   Additive migration: the template reorganized its stylesheet into\n'
    printf '   first-paint token fallbacks + global component classes driven by\n'
    printf '   web/src/design/design.json. This block is appended AFTER your\n'
    printf '   existing rules, so it wins the cascade over both the old template\n'
    printf '   token block and any custom rule that reuses a template class name.\n'
    printf '   Custom rules that only style YOUR own classes are unaffected.\n'
    printf '   Never edit the numbers below — edit design.json (or /#/design).\n'
    printf '   ───────────────────────────────────────────────────────────── */\n\n'
    cat "$TEMPLATE_ROOT/web/src/app.css"
  } >> "$file"
  ok "patch app.css (appended design-system block)"
}

patch_claude_md() {
  # CLAUDE.md is customer-tunable: missing anchors warn but never fail —
  # a stale doc must not abort a working retrofit.
  local file="$1/CLAUDE.md"
  if [ ! -f "$file" ]; then warn "missing $file"; return; fi
  python3 - "$file" "$TEMPLATE_ROOT" <<'PY'
import sys
path, template_root = sys.argv[1], sys.argv[2]
src = open(path).read()
tmpl = open(template_root + "/CLAUDE.md").read()
warned = []

def section(src, start_marker):
    """Lines from the heading `start_marker` up to (not incl.) the next '## '."""
    lines = src.split("\n")
    start = next((i for i, l in enumerate(lines) if l.startswith(start_marker)), None)
    if start is None:
        return None, None
    end = len(lines)
    for j in range(start + 1, len(lines)):
        if lines[j].startswith("## "):
            end = j
            break
    return start, end

# 1. Typography section → Design system section (extracted from THIS
#    template's CLAUDE.md so the copy never drifts).
if "## Design system" in src:
    print("SKIP: Design system section already present")
elif "## Typography" not in src:
    print("WARN: no '## Typography' section to replace — merge manually")
else:
    tstart, _ = section(tmpl, "## Design system")
    if tstart is None:
        print("WARN: template CLAUDE.md has no Design system section — merge manually")
    else:
        tl = tmpl.split("\n")
        tend = len(tl)
        for j in range(tstart + 1, len(tl)):
            if tl[j].startswith("## "):
                tend = j
                break
        new_section = "\n".join(tl[tstart:tend]).rstrip() + "\n"
        s, e = section(src, "## Typography")
        src = "\n".join(src.split("\n")[:s]) + "\n" + new_section + "\n".join(src.split("\n")[e:])

# 2. Spoke row after services-jobs.md.
if "| `design.md`" in src:
    print("SKIP: design.md spoke row already present")
else:
    lines = src.split("\n")
    idx = next((i for i, l in enumerate(lines) if "| `services-jobs.md`" in l), None)
    if idx is None:
        print("WARN: no services-jobs.md spoke row — add the design.md row manually")
    else:
        row = "| `design.md` | `web/src/design/**`, `app.css`, `*.svelte` | design.json, presets, font catalog, token rules, the /#/design sheet |"
        lines.insert(idx + 1, row)
        src = "\n".join(lines)

# 3. Pitfall bullets appended to the Common Pitfalls list.
if "The look lives in `web/src/design/design.json`" in src:
    print("SKIP: design pitfalls already present")
else:
    lines = src.split("\n")
    pit_start = next((i for i, l in enumerate(lines) if l.startswith("## Common Pitfalls")), None)
    if pit_start is None:
        print("WARN: no Common Pitfalls section — add the design pitfalls manually")
    else:
        last_bullet = max(i for i in range(pit_start, len(lines)) if lines[i].startswith("- **"))
        bullets = [
            "- **The look lives in `web/src/design/design.json`** -- never hardcode a `font-family`, a hex colour or a font `<link>`; never edit `app.css` token values to restyle",
            "- **New UI component = add it to `/#/design`** in the same change, using global classes from `app.css`",
            "- **`.env` wins over exported variables under `deno run --env`** (observed: `PORT=8100 deno task dev` still bound the `.env` port). To run the API against a different DB or port, run `main.ts` without `--env` and pass every variable explicitly",
        ]
        lines[last_bullet + 1:last_bullet + 1] = bullets
        src = "\n".join(lines)

open(path, "w").write(src)
PY
  if python3 -c 'import sys; sys.exit(0 if "## Design system" in open(sys.argv[1]).read() else 1)' "$file"; then
    ok "patch CLAUDE.md"
  else
    warn "CLAUDE.md partially patched — check WARN lines above and merge manually"
  fi
}

report_collisions() {
  # Custom rules in the target's app.css that reuse template component
  # class names: the appended block wins the cascade over them.
  # Grep only the PRE-EXISTING part — everything from the sentinel
  # comment down is our own appended block, not a customer override.
  local file="$1/web/src/app.css"
  [ -f "$file" ] || return 0
  local hits
  hits=$(awk '/design system tokens \+ components \(template 11fdd8c\)/{exit} {print}' "$file" \
    | grep -nE '^\s*\.?(btn|card|input|select|textarea|alert|badge|tabs|table|avatar|divider|skeleton|stack|row|switch|checkbox|radio)[ ,:{.#]' || true)
  if [ -n "$hits" ]; then
    printf "  [flag] target app.css rules reusing template class names (appended block now wins the cascade — re-pin intentional overrides):\n%s\n" "$hits"
  fi
}

flag_hardcodes() {
  # Literal font-family / hex in the target's svelte files → follow-up ticket.
  # Stripped before matching: var(--x, #fallback) spans (sanctioned token
  # indirection) and SVG fill/stroke attributes (third-party brand marks).
  local flags hex
  flags=$(grep -rnE --include='*.svelte' 'font-family:' "$1/web/src" 2>/dev/null \
    | grep -v 'DevPanel.svelte' \
    | perl -pe 's/var\([^)]*\)//g' \
    | grep -E 'font-family:\s*[A-Za-z"'\'']' || true)
  hex=$(grep -rnE --include='*.svelte' '#[0-9a-fA-F]{3,8}\b' "$1/web/src" 2>/dev/null \
    | grep -v 'DevPanel.svelte' \
    | perl -pe 's/var\([^)]*\)//g; s/(fill|stroke)="[^"]*"//g' \
    | grep -E '#[0-9a-fA-F]{3,8}\b' || true)
  if [ -z "$flags$hex" ]; then
    ok "no hardcoded font-family / hex in web/src/**/*.svelte"
  else
    printf "  [flag] hardcoded fonts/colours in web/src/**/*.svelte — open a follow-up ticket:\n"
    [ -n "$flags" ] && printf "%s\n" "$flags"
    [ -n "$hex" ] && printf "%s\n" "$hex"
    printf "  [flag] (DevPanel.svelte excluded — dev tooling with its own fixed theme)\n"
  fi
}

apply_preset() {
  local target="$1" preset="$2"
  if (cd "$target" && deno task design apply "$preset" >/dev/null 2>&1); then
    ok "applied preset '$preset' to web/src/design/design.json"
  else
    fail "deno task design apply '$preset' failed in $target — run it manually to see the error"
  fi
}

# ── Driver ─────────────────────────────────────────────────────────

apply_to() {
  local target="$1" preset="$2"
  if [ ! -d "$target" ]; then
    fail "target not a directory: $target"
  fi
  if [ ! -f "$target/app.ts" ] || [ ! -d "$target/web" ]; then
    warn "$target doesn't look like a template clone (missing app.ts or web/), skipping"
    return
  fi
  printf "\n→ %s\n" "$target"
  copy_new_files "$target"
  patch_main_ts "$target"
  patch_routes_ts "$target"
  patch_sidebar_svelte "$target"
  patch_index_html "$target"
  patch_dev_routes "$target"
  patch_deno_json "$target"
  patch_app_css "$target"
  report_collisions "$target"
  patch_claude_md "$target"
  flag_hardcodes "$target"
  if [ -n "$preset" ]; then
    apply_preset "$target" "$preset"
  else
    warn "no --preset given: $target/web/src/design/design.json ships as template-default 'clean' — run the per-project design step (match on the product description, preview on /#/design)"
  fi
}

# ── Arg parsing ────────────────────────────────────────────────────

preset=""
targets=()
while [ $# -gt 0 ]; do
  case "$1" in
    --preset)
      [ $# -ge 2 ] || fail "--preset requires a preset id (clean|modern|editorial|friendly|corporate|luxury|brutalist|dark|organic)"
      preset="$2"; shift 2 ;;
    --all)
      targets+=(--all); shift ;;
    -*)
      fail "unknown option: $1" ;;
    *)
      targets+=("$1"); shift ;;
  esac
done

if [ ${#targets[@]} -eq 0 ]; then
  printf "usage: %s <target-dir> [--preset <id>]\n       %s --all [--preset <id>]\n" "$0" "$0" >&2
  exit 1
fi

for t in "${targets[@]}"; do
  if [ "$t" = "--all" ]; then
    for dir in ~/.alchemist/projects/*/; do
      apply_to "${dir%/}" "$preset"
    done
  else
    apply_to "$t" "$preset"
  fi
done

printf "\nDone. Per-target acceptance:\n"
printf "  cd <target>/web && npm install --silent && npm run build   # must produce dist/index.html\n"
printf "  cd <target> && deno check main.ts\n"
printf "  deno task design check                                     # WCAG gate\n"
printf "  open http://localhost:<vite>/#/design                      # sheet renders under the live design\n"