#!/usr/bin/env bash
#
# Idempotently apply the native TypeScript 7 type check (2026-10-08) to an
# existing customer-project clone of this template. Customer projects don't
# track this template as a git remote, so this copies the template-owned files
# and patches the touched existing files in place. A re-run is a no-op.
#
# Usage:
#   scripts/apply-type-check-to-clones.sh <target-project-dir>
#   scripts/apply-type-check-to-clones.sh --all   # walks ~/.alchemist/projects/*
#
# What it does:
#   • Copies 2 template-owned files (always overwritten, never edited per project):
#       scripts/lib/tsgo-check.ts
#       scripts/check-types.ts
#   • Rewrites the deno.json tasks `check`, `check:tests`, `check:touched` from
#     `deno check <args>` to `scripts/check-types.ts <args>`, keeping <args>.
#     A task that is not a plain `deno check ...` was customized and is left
#     alone (reported).
#   • Replaces the CI step `run: deno check <args>` with `deno task check` plus
#     a `CHECK_ENGINE=deno` parity step. Anything else in ci.yml is untouched.
#   • Adds src/__tests__/kysely-unscoped-db-fn.test.ts ONLY when the project
#     has no unscoped `db.fn` column aggregate; otherwise lists them, so the
#     lint never lands red.
#   • Skips CLAUDE.md (customer-tunable).
#
# Safe on old Deno: check-types.ts runs plain `deno check` on Deno < 2.9, so a
# project whose CI pins 2.3.1 checks exactly what it checked before.
#
# Does NOT commit or push. Review `git diff` in the target, run the tests it
# flags (tests that read deno.json or CI config), then commit.

set -euo pipefail

TEMPLATE_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUNNER='deno run --allow-read --allow-write --allow-run --allow-env --allow-sys scripts/check-types.ts'
DBFN_RE='\b(db|trx|tx)\.fn\.(count|max|min|sum|avg|agg|coalesce)\s*(<[^>()]*>)?\(\s*["'"'"'`]'

ok()   { printf "  [ok]   %s\n" "$1"; }
skip() { printf "  [skip] %s\n" "$1"; }
warn() { printf "  [warn] %s\n" "$1" >&2; }
fail() { printf "  [fail] %s\n" "$1" >&2; exit 1; }

copy_owned_files() {
  local target="$1"
  for rel in "scripts/lib/tsgo-check.ts" "scripts/check-types.ts"; do
    mkdir -p "$(dirname "$target/$rel")"
    if [ -f "$target/$rel" ] && cmp -s "$TEMPLATE_ROOT/$rel" "$target/$rel"; then
      skip "$rel already current"
    else
      cp "$TEMPLATE_ROOT/$rel" "$target/$rel"
      ok "copy $rel"
    fi
  done
}

# Rewrite one task line in place; keeps the file's own formatting.
patch_deno_json() {
  local file="$1/deno.json"
  if [ ! -f "$file" ]; then warn "missing $file"; return; fi
  python3 - "$file" "$RUNNER" <<'PY'
import re, sys
path, runner = sys.argv[1], sys.argv[2]
src = open(path).read()
out = src
for task in ("check", "check:tests", "check:touched"):
    m = re.search(r'("' + re.escape(task) + r'"\s*:\s*")([^"]*)(")', out)
    if not m:
        continue
    body = m.group(2)
    if "scripts/check-types.ts" in body:
        print(f"  [skip] deno.json task {task} already uses check-types.ts")
        continue
    plain = re.fullmatch(r"deno check(?:\s+(.*))?", body.strip())
    if not plain:
        print(f"  [warn] deno.json task {task} is customized ({body!r}); left alone", file=sys.stderr)
        continue
    rest = plain.group(1) or ""
    new = (runner + (" " + rest if rest else "")).strip()
    out = out[: m.start(2)] + new + out[m.end(2):]
    print(f"  [ok]   deno.json task {task} -> check-types.ts{(' ' + rest) if rest else ''}")
if out != src:
    open(path, "w").write(out)
PY
}

patch_ci() {
  local file="$1/.github/workflows/ci.yml"
  if [ ! -f "$file" ]; then skip "no .github/workflows/ci.yml"; return; fi
  if grep -q 'CHECK_ENGINE=deno deno task check' "$file"; then
    skip "ci.yml already runs both engines"
    return
  fi
  # CI switches to `deno task check` only when that task now runs
  # check-types.ts. A customized check task would make CI run something
  # other than what it ran before.
  if ! python3 -c 'import json,sys; t=json.load(open(sys.argv[1])).get("tasks",{}).get("check",""); sys.exit(0 if "scripts/check-types.ts" in t else 1)' "$1/deno.json" 2>/dev/null; then
    warn "ci.yml left alone: the deno.json check task does not run check-types.ts"
    return
  fi
  python3 - "$file" <<'PY'
import re, sys
path = sys.argv[1]
src = open(path).read()
pat = re.compile(r'^(?P<ind>[ \t]*)- name: (?P<name>[^\n]*)\n(?P=ind)  run: deno check [^\n]*\n', re.M)
m = pat.search(src)
if not m:
    print("  [warn] ci.yml: no `- name: ...` + `run: deno check ...` step found; left alone", file=sys.stderr)
    sys.exit(0)
ind = m.group("ind")
block = (
    f"{ind}# Native TypeScript 7 engine (scripts/check-types.ts), then Deno's own\n"
    f"{ind}# checker on the same files; either failing fails the job.\n"
    f"{ind}- name: {m.group('name')}\n{ind}  run: deno task check\n\n"
    f"{ind}- name: {m.group('name')} (deno check parity)\n{ind}  run: CHECK_ENGINE=deno deno task check\n"
)
open(path, "w").write(src[: m.start()] + block + src[m.end():])
print("  [ok]   ci.yml type check runs both engines")
PY
}

add_kysely_lint() {
  local target="$1" rel="src/__tests__/kysely-unscoped-db-fn.test.ts"
  if [ -f "$target/$rel" ]; then skip "$rel already present"; return; fi
  local hits
  hits="$(grep -rnE "$DBFN_RE" "$target/src" "$target/db" 2>/dev/null | grep '\.ts:' | grep -v '__tests__' || true)"
  if [ -n "$hits" ]; then
    warn "NOT adding $rel: convert these to .select((eb) => [eb.fn...]) first:"
    printf '%s\n' "$hits" | sed "s#^$target/#         #" >&2
    return
  fi
  mkdir -p "$(dirname "$target/$rel")"
  cp "$TEMPLATE_ROOT/$rel" "$target/$rel"
  ok "add $rel"
}

apply_to() {
  local target="$1"
  [ -d "$target" ] || fail "target not a directory: $target"
  if [ ! -f "$target/main.ts" ] || [ ! -f "$target/deno.json" ]; then
    warn "$target doesn't look like a template clone (missing main.ts or deno.json), skipping"
    return
  fi
  # chipp-deno itself (mirrored under ~/.alchemist/projects) has its own
  # check engine in scripts/check-project.ts; never patch it.
  if [ -f "$target/scripts/check-project.ts" ]; then
    skip "$target is chipp-deno (has scripts/check-project.ts), skipping"
    return
  fi
  printf "\n→ %s\n" "$target"
  copy_owned_files "$target"
  patch_deno_json "$target"
  patch_ci "$target"
  add_kysely_lint "$target"
  flag_config_tests "$target"
}

# A project's own tests can pin the very commands this script rewrites.
# 2026-10-08 fleet rollout: two of 96 repos went red in CI on exactly this
# (one pins the literal `deno check main.ts` CI step, one scans every
# `deno run ... main.ts` command in deno.json). Both engines and the lint
# passed locally; these tests were never run. Name them so they are.
flag_config_tests() {
  local target="$1" hits
  hits="$(grep -rlE 'deno check|\.github/workflows|deno\.json' "$target/src/__tests__" 2>/dev/null \
    | grep -E '\.test\.ts$|_test\.ts$' | grep -v 'kysely-unscoped-db-fn' || true)"
  if [ -n "$hits" ]; then
    warn "these tests read deno.json / CI config / deno check; run them before committing:"
    printf '%s\n' "$hits" | sed "s#^$target/#         #" >&2
  fi
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

printf "\nDone. Review \`git diff\` in each target, then commit.\n"
