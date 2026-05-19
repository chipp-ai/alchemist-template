#!/usr/bin/env bash
#
# Idempotently apply the unified-observability changes to an existing
# customer-project clone of this template. Customer projects don't
# track this template as a git remote (each is provisioned as its own
# GitHub repo), so this script copies the new observability files and
# patches the touched existing files in place, guarded by sentinels
# so a re-run is a no-op.
#
# Usage:
#   scripts/apply-observability-to-clones.sh <target-project-dir>
#   scripts/apply-observability-to-clones.sh --all   # walks ~/.alchemist/projects/*
#
# What it does:
#   • Copies 4 new files from this template into the target:
#       src/observability/jsonl-writer.ts
#       src/observability/envelope.ts
#       src/api/routes/observability/index.ts
#       web/src/lib/observability/breadcrumbs.ts
#   • Idempotently patches 4 existing files:
#       app.ts                    (import + route mount)
#       src/lib/logger.ts         (import + obs hook in emit)
#       src/lib/dev-activity.ts   (import + obs hooks in recordRequest/Error)
#       web/src/main.ts           (import + installBreadcrumbs call)
#   • Skips CLAUDE.md (customer-tunable; we don't want to clobber).
#
# Failure mode: any patch step that can't apply (because the target
# file was modified in a way that broke the anchor) is reported with
# a clear message and the script exits non-zero. The new files are
# always copied successfully; only the patches are anchor-sensitive.

set -euo pipefail

TEMPLATE_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# ── Helpers ────────────────────────────────────────────────────────

ok()    { printf "  [ok]   %s\n" "$1"; }
skip()  { printf "  [skip] %s\n" "$1"; }
warn()  { printf "  [warn] %s\n" "$1" >&2; }
fail()  { printf "  [fail] %s\n" "$1" >&2; exit 1; }

# Insert a block of text into a file directly after the line matching
# a sentinel pattern. Idempotent — guarded by a presence check before
# calling. We use awk so we don't depend on a particular sed flavor
# (BSD vs GNU).
insert_after() {
  local file="$1" anchor="$2" block="$3"
  awk -v anchor="$anchor" -v block="$block" '
    { print }
    !done && match($0, anchor) { print block; done = 1 }
  ' "$file" > "$file.tmp" && mv "$file.tmp" "$file"
}

# ── Per-file applicators ───────────────────────────────────────────

copy_new_files() {
  local target="$1"
  for rel in \
      "src/observability/jsonl-writer.ts" \
      "src/observability/envelope.ts" \
      "src/api/routes/observability/index.ts" \
      "web/src/lib/observability/breadcrumbs.ts"
  do
    mkdir -p "$(dirname "$target/$rel")"
    cp "$TEMPLATE_ROOT/$rel" "$target/$rel"
    ok "copy $rel"
  done
}

patch_app_ts() {
  local file="$1/app.ts"
  if [ ! -f "$file" ]; then warn "missing $file"; return; fi
  if grep -q "observabilityRoutes" "$file"; then
    skip "app.ts already patched"
    return
  fi
  # Use Python for robust anchor finding — different customer
  # projects have different route imports (customer-added routes,
  # missing realtime, etc.), so we can't rely on a specific named
  # import. Instead:
  #   • Insert the import after the LAST `from "@/api/routes/...` line
  #   • Insert the mount after the LAST `app.route("/api/...` line
  python3 - "$file" <<'PY'
import sys, re
path = sys.argv[1]
src = open(path).read()
if "observabilityRoutes" in src:
    sys.exit(0)

lines = src.split("\n")

# Find the last line that imports something from @/api/routes/.
last_route_import = -1
for i, line in enumerate(lines):
    if re.search(r'from\s+"@/api/routes/', line):
        last_route_import = i
if last_route_import < 0:
    print("ERR: app.ts has no @/api/routes/ imports — can't anchor observability import", file=sys.stderr)
    sys.exit(1)
lines.insert(
    last_route_import + 1,
    'import { observabilityRoutes } from "@/api/routes/observability/index.ts";',
)

# Find the last line that calls app.route("/api/.
last_route_mount = -1
for i, line in enumerate(lines):
    if re.search(r'app\.route\("/api/', line):
        last_route_mount = i
if last_route_mount < 0:
    print("ERR: app.ts has no app.route(\"/api/...\") calls — can't anchor observability mount", file=sys.stderr)
    sys.exit(1)
lines.insert(
    last_route_mount + 1,
    '',
)
lines.insert(
    last_route_mount + 2,
    '// Observability collector — receives batched client breadcrumbs and',
)
lines.insert(
    last_route_mount + 3,
    '// writes to the unified .scratch/logs/observability.jsonl stream.',
)
lines.insert(
    last_route_mount + 4,
    'app.route("/api/_observability", observabilityRoutes);',
)

open(path, "w").write("\n".join(lines))
PY
  ok "patch app.ts"
}

patch_logger_ts() {
  local file="$1/src/lib/logger.ts"
  if [ ! -f "$file" ]; then warn "missing $file"; return; fi
  if grep -q "recordServerEvent" "$file"; then
    skip "logger.ts already patched"
    return
  fi
  # Prepend the import at the top of the file (above the first existing line).
  printf 'import { recordServerEvent } from "@/observability/envelope.ts";\n\n%s\n' "$(cat "$file")" > "$file.tmp"
  mv "$file.tmp" "$file"
  # Append a hook call inside emit(). Locate the closing brace of
  # emit() and inject before it. We look for the function signature
  # then the next standalone "}" line — that's emit's terminator
  # given the template's bracing style.
  python3 - "$file" <<'PY'
import sys, re
path = sys.argv[1]
src = open(path).read()
m = re.search(r"function emit\(\s*\n[\s\S]*?\n\}\n", src)
if not m:
    print("ERR: could not find emit() in logger.ts", file=sys.stderr)
    sys.exit(1)
body = m.group(0)
if "recordServerEvent" in body:
    sys.exit(0)
hook = """  // Mirror to the unified observability stream (server.log.<level>).
  const obsData: Record<string, unknown> = { msg, ...ctx };
  if (error !== undefined) {
    const ser = serializeError(error);
    obsData.error_name = ser.name;
    obsData.error_message = ser.message;
    if (ser.stack) obsData.error_stack = ser.stack;
  }
  recordServerEvent(`server.log.${level}`, obsData);
"""
# Insert before the function's closing brace.
new_body = body.rstrip().rstrip("}") + "\n" + hook + "}\n"
open(path, "w").write(src.replace(body, new_body))
PY
  ok "patch logger.ts"
}

patch_dev_activity_ts() {
  local file="$1/src/lib/dev-activity.ts"
  if [ ! -f "$file" ]; then warn "missing $file"; return; fi
  if grep -q "recordServerEvent" "$file"; then
    skip "dev-activity.ts already patched"
    return
  fi
  # Prepend the import.
  printf 'import { recordServerEvent } from "@/observability/envelope.ts";\n\n%s\n' "$(cat "$file")" > "$file.tmp"
  mv "$file.tmp" "$file"
  # Insert the two hook calls before each function's closing brace.
  python3 - "$file" <<'PY'
import sys, re
path = sys.argv[1]
src = open(path).read()

req_hook = """  recordServerEvent("server.http", {
    method: record.method,
    path: record.path,
    routePath: record.routePath,
    status: record.status,
    durationMs: record.durationMs,
    isError: record.isError,
  });
"""

err_hook = """  recordServerEvent("server.error", {
    message: record.message,
    stack: record.stack,
    source: record.source,
    request: record.request,
  });
"""

def inject(src, fn_name, hook):
    m = re.search(rf"export function {fn_name}\([\s\S]*?\n\}}\n", src)
    if not m:
        print(f"ERR: could not find {fn_name} in dev-activity.ts", file=sys.stderr)
        sys.exit(1)
    body = m.group(0)
    if "recordServerEvent" in body:
        return src
    new_body = body.rstrip().rstrip("}") + "\n" + hook + "}\n"
    return src.replace(body, new_body)

src = inject(src, "recordRequest", req_hook)
src = inject(src, "recordError", err_hook)
open(path, "w").write(src)
PY
  ok "patch dev-activity.ts"
}

patch_deno_json() {
  local file="$1/deno.json"
  if [ ! -f "$file" ]; then warn "missing $file"; return; fi
  # The migration script imports the logger, which now mirrors every
  # emit to .scratch/logs/observability.jsonl. Without a narrow
  # --allow-write, every log line during migration is a thrown-and-
  # caught Deno.errors.PermissionDenied — the writer latches off
  # after the first one (see jsonl-writer.ts), but granting write
  # specifically to .scratch/logs lets migration events actually
  # appear in the stream.
  if grep -q '"db:migrate".*--allow-write=\.scratch/logs' "$file"; then
    skip "deno.json already patched"
    return
  fi
  python3 - "$file" <<'PY'
import sys, re, json
path = sys.argv[1]
src = open(path).read()
# JSONC: deno.json supports comments + trailing commas. We can't
# round-trip via json.loads/dumps without losing the comments and
# changing whitespace. Patch via regex on the db:migrate line.
m = re.search(r'("db:migrate"\s*:\s*")([^"]*)(")', src)
if not m:
    print("ERR: deno.json has no db:migrate task — skipping permission patch", file=sys.stderr)
    sys.exit(0)
cmd = m.group(2)
if "--allow-write=.scratch/logs" in cmd or "--allow-write" in cmd:
    sys.exit(0)
# Insert --allow-write=.scratch/logs after the existing --allow-read flag,
# or before the script path if --allow-read isn't there.
if "--allow-read" in cmd:
    new_cmd = cmd.replace("--allow-read", "--allow-read --allow-write=.scratch/logs", 1)
else:
    new_cmd = cmd.replace(" db/", " --allow-write=.scratch/logs db/", 1)
new_src = src[:m.start(2)] + new_cmd + src[m.end(2):]
open(path, "w").write(new_src)
PY
  ok "patch deno.json"
}

patch_web_main_ts() {
  local file="$1/web/src/main.ts"
  if [ ! -f "$file" ]; then warn "missing $file"; return; fi
  if grep -q "installBreadcrumbs" "$file"; then
    skip "web/src/main.ts already patched"
    return
  fi
  # Prepend the import + the install call right after the first three
  # canonical imports (mount + App + app.css).
  python3 - "$file" <<'PY'
import sys
path = sys.argv[1]
src = open(path).read()
if "installBreadcrumbs" in src:
    sys.exit(0)
addition = '''import { installBreadcrumbs } from "./lib/observability/breadcrumbs";

// Install observability hooks BEFORE the rest of bootup so the
// store + DevPanel + app mount are captured. No-op in production.
installBreadcrumbs();

'''
# Insert after the third import line (mount, App, app.css).
lines = src.split("\n")
insert_at = None
import_count = 0
for i, line in enumerate(lines):
    if line.startswith("import "):
        import_count += 1
        if import_count == 3:
            insert_at = i + 1
            break
if insert_at is None:
    insert_at = 0
out = "\n".join(lines[:insert_at]) + "\n" + addition + "\n".join(lines[insert_at:])
open(path, "w").write(out)
PY
  ok "patch web/src/main.ts"
}

# ── Driver ─────────────────────────────────────────────────────────

apply_to() {
  local target="$1"
  if [ ! -d "$target" ]; then
    fail "target not a directory: $target"
  fi
  if [ ! -f "$target/app.ts" ] || [ ! -d "$target/web" ]; then
    warn "$target doesn't look like a template clone (missing app.ts or web/), skipping"
    return
  fi
  printf "\n→ %s\n" "$target"
  copy_new_files "$target"
  patch_app_ts "$target"
  patch_logger_ts "$target"
  patch_dev_activity_ts "$target"
  patch_web_main_ts "$target"
  patch_deno_json "$target"
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
