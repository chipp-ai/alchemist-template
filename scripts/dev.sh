#!/usr/bin/env bash
set -euo pipefail

# ===========================================================================
# dev.sh — Start the full development stack (API + Vite + Docker services)
#
# Usage:
#   ./scripts/dev.sh --api-port 8000 --port 5173
#
# Both --api-port and --port are REQUIRED. The script refuses to start with
# defaults because multiple agents may run against the same repo in parallel
# worktrees, each needing its own port pair.
# ===========================================================================

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# ── Parse arguments ──

API_PORT=""
VITE_PORT=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --api-port)
      API_PORT="$2"
      shift 2
      ;;
    --port)
      VITE_PORT="$2"
      shift 2
      ;;
    -h|--help)
      echo "Usage: ./scripts/dev.sh --api-port PORT --port VITE_PORT"
      echo ""
      echo "  --api-port PORT    Deno API server port (required)"
      echo "  --port VITE_PORT   Vite dev server port (required)"
      exit 0
      ;;
    *)
      echo "Unknown argument: $1"
      echo "Usage: ./scripts/dev.sh --api-port PORT --port VITE_PORT"
      exit 1
      ;;
  esac
done

if [[ -z "$API_PORT" || -z "$VITE_PORT" ]]; then
  echo "Error: Both --api-port and --port are required."
  echo ""
  echo "Usage: ./scripts/dev.sh --api-port PORT --port VITE_PORT"
  echo "Example: ./scripts/dev.sh --api-port 8000 --port 5173"
  exit 1
fi

# ── Read .env for DB_PORT (default 5432) ──

DB_PORT="${DB_PORT:-5432}"
if [[ -f "$PROJECT_ROOT/.env" ]]; then
  # Source only DB_PORT if present
  _db_port=$(grep -E '^DB_PORT=' "$PROJECT_ROOT/.env" 2>/dev/null | head -1 | cut -d= -f2)
  if [[ -n "$_db_port" ]]; then
    DB_PORT="$_db_port"
  fi
fi

# ── Re-derive DATABASE_URL when DB_PORT is remapped ──
#
# The customer template's .env ships with
#   DATABASE_URL=postgres://postgres:postgres@localhost:5432/app_dev
# (matches docker-compose's default). When the desktop dev-server
# remaps DB_PORT to dodge a host-port conflict (e.g. an
# alchemist-test-pg container squatting on 5432), DATABASE_URL stays
# pointed at 5432 → deno task db:migrate authenticates against the
# WRONG postgres instance, fails silently, dev.sh trap aborts. Export
# a corrected DATABASE_URL whenever DB_PORT diverges from 5432; this
# overrides the .env value the Deno --env flag would otherwise load
# (process env wins over .env in Deno's --env loader).
if [[ "$DB_PORT" != "5432" ]]; then
  export DATABASE_URL="postgres://postgres:postgres@localhost:${DB_PORT}/app_dev"
  echo "Remapped DATABASE_URL → port ${DB_PORT}"
fi

# ── Create log directory ──

mkdir -p "$PROJECT_ROOT/.scratch/logs"

# ── Track background PIDs for cleanup ──

PIDS=()

cleanup() {
  echo ""
  echo "Shutting down dev stack..."
  for pid in ${PIDS[@]+"${PIDS[@]}"}; do
    if kill -0 "$pid" 2>/dev/null; then
      kill "$pid" 2>/dev/null || true
    fi
  done
  # Wait briefly, then force-kill stragglers
  sleep 1
  for pid in ${PIDS[@]+"${PIDS[@]}"}; do
    if kill -0 "$pid" 2>/dev/null; then
      kill -9 "$pid" 2>/dev/null || true
    fi
  done
  echo "Dev stack stopped."
}

trap cleanup SIGINT SIGTERM EXIT

# ── Backing services: prefer alchemist-desktop's bundled pg + redis ──
#
# The alchemist-desktop app bundles Postgres on port 5433 and Redis on
# port 6379 (see desktop/src-tauri/src/local_services.rs). When those
# are reachable, use them directly — no Docker dependency, no
# docker-compose lifecycle to manage, no per-project image pulls.
# The bundled Postgres ships full standard contrib + pgvector via the
# chipp-ai/postgres-bundle distribution, matching production Cloud SQL.
#
# Docker remains the fallback for environments where the desktop
# isn't running (headless CI, a teammate without the .app, etc.).

BUNDLED_PG_PORT=5433
# The desktop's bundled Redis binds 6380 (NOT the default 6379) so it
# coexists with any other Redis the user might have running for
# other apps (Docker stacks, brew services, etc.). Mirror that here.
BUNDLED_REDIS_PORT=6380
USE_BUNDLED_SERVICES=0
if nc -z localhost "$BUNDLED_PG_PORT" 2>/dev/null && nc -z localhost "$BUNDLED_REDIS_PORT" 2>/dev/null; then
  USE_BUNDLED_SERVICES=1
fi

if [[ "$USE_BUNDLED_SERVICES" = "1" ]]; then
  # Per-project database name — multiple customer projects can run
  # against the same bundled pg without colliding. Hash the project
  # root so the name is stable across runs but unique per clone.
  PROJECT_HASH=$(echo -n "$PROJECT_ROOT" | shasum -a 256 | cut -c1-8)
  PROJECT_DB="app_dev_${PROJECT_HASH}"
  export DATABASE_URL="postgres://postgres:postgres@localhost:${BUNDLED_PG_PORT}/${PROJECT_DB}"
  export REDIS_URL="redis://localhost:${BUNDLED_REDIS_PORT}"
  echo "Using alchemist-desktop bundled services:"
  echo "  Postgres → localhost:${BUNDLED_PG_PORT} (db: ${PROJECT_DB})"
  echo "  Redis    → localhost:${BUNDLED_REDIS_PORT}"
  # Ensure the per-project database exists before migrating. db/_runner.ts
  # has an auto-create path (ensureDatabaseExists), but customer projects
  # cloned BEFORE the runner-extraction refactor ship a standalone
  # migrate.ts without it — so a fresh dev.sh against an older clone
  # would hit `database "app_dev_<hash>" does not exist`, retry three
  # times, and shut down. Doing the CREATE here at the script level
  # catches both shapes (old inlined runner AND modern thin shim) AND
  # works when the desktop's per-project pre-create isn't running (e.g.
  # the operator runs ./scripts/dev.sh directly outside the desktop).
  # Idempotent: re-runs find the DB present and no-op.
  echo "Ensuring database ${PROJECT_DB} exists..."
  deno eval --no-config "
const postgres = (await import('npm:postgres@3.4.5')).default;
const meta = postgres('postgres://postgres:postgres@localhost:${BUNDLED_PG_PORT}/postgres', { max: 1 });
try {
  await meta\`CREATE DATABASE \"${PROJECT_DB}\"\`;
  console.log('[dev.sh] created database ${PROJECT_DB}');
} catch (e) {
  if (!/already exists/i.test(String(e))) {
    console.error('[dev.sh] CREATE DATABASE failed:', e);
    Deno.exit(1);
  }
} finally {
  await meta.end({ timeout: 5 });
}
"

else
  # ── Docker fallback (legacy path) ──

  if ! docker info >/dev/null 2>&1; then
    cat <<EOF
Error: alchemist-desktop's bundled services (Postgres :${BUNDLED_PG_PORT},
Redis :${BUNDLED_REDIS_PORT}) are not reachable, and Docker is not
running as a fallback. Either:
  • Start the alchemist-desktop app (recommended — no Docker needed), or
  • Start Docker Desktop and re-run this script.
EOF
    exit 1
  fi

  echo "Bundled services not detected — falling back to docker-compose."
  echo "Checking Docker services..."
  cd "$PROJECT_ROOT"

  if ! docker compose ps --status running 2>/dev/null | grep -q "postgres"; then
    echo "Starting Docker services (postgres, redis)..."
    docker compose up -d
    echo "Docker services started."
  else
    echo "Docker services already running."
  fi

  # Probe via `docker compose exec` so the host doesn't need libpq
  # installed (it usually isn't on a fresh macOS dev box).
  echo "Waiting for PostgreSQL on port $DB_PORT..."
  RETRIES=0
  MAX_RETRIES=30
  while ! docker compose exec -T postgres pg_isready -U postgres -q 2>/dev/null; do
    RETRIES=$((RETRIES + 1))
    if [[ $RETRIES -ge $MAX_RETRIES ]]; then
      echo "Error: PostgreSQL not ready after ${MAX_RETRIES}s (host port $DB_PORT)."
      echo "Check: docker compose logs postgres"
      exit 1
    fi
    sleep 1
  done
  echo "PostgreSQL is ready."
fi

# ── Run migrations ──
#
# Refresh the migration runner from the template before invoking
# migrate. Customer projects import the runner via raw.githubusercontent
# (https://.../alchemist-template/staging/db/_runner.ts) so template
# fixes propagate without per-project commits — but the customer
# project's deno.lock pins the runner's content hash. Without an
# explicit reload, a template push that changes _runner.ts triggers
# Deno's integrity check on every customer's next dev.sh:
#   "Integrity check failed for remote specifier. The source code is
#   invalid, as it does not match the expected hash in the lock file."
# The reload below refetches AND rewrites the lock entry in one step,
# so the customer never sees that error — they just get the latest
# runner transparently. Cost: ~200ms per dev.sh (the URL has a short
# cache TTL anyway).

RUNNER_URL="https://raw.githubusercontent.com/chipp-ai/alchemist-template/staging/db/_runner.ts"
echo "Refreshing migration runner from template..."
cd "$PROJECT_ROOT"
deno cache --reload="$RUNNER_URL" db/migrate.ts > /dev/null 2>&1 || true

echo "Running database migrations..."
deno task db:migrate
echo ""

# ── Write port configuration to .claude/local-dev.md ──

mkdir -p "$PROJECT_ROOT/.claude"
cat > "$PROJECT_ROOT/.claude/local-dev.md" <<EOF
# Local Dev Ports

| Service | Port | URL |
|---------|------|-----|
| Vite SPA | $VITE_PORT | http://localhost:$VITE_PORT |
| Deno API | $API_PORT | http://localhost:$API_PORT |

When docs reference \`__VITE_PORT__\`, use **$VITE_PORT**. When they reference \`__API_PORT__\`, use **$API_PORT**.
EOF

# ── Start Deno API server ──

echo "Starting Deno API on port $API_PORT..."
cd "$PROJECT_ROOT"
PORT="$API_PORT" deno task dev > "$PROJECT_ROOT/.scratch/logs/server.log" 2>&1 &
PIDS+=($!)

# ── Ensure web dependencies ──
#
# Fresh clones don't have web/node_modules — Vite would then try to
# resolve @sveltejs/vite-plugin-svelte and friends, fail, and the
# SPA port never binds. Run `npm install` once so Vite actually
# starts. Idempotent on subsequent runs (npm install is fast when
# the lockfile + node_modules are in sync). `npm ci` would be
# stricter but errors on any lockfile drift; install is more
# forgiving for a customer template that ships with package-lock
# but is also frequently regenerated by user edits.

if [ ! -d "$PROJECT_ROOT/web/node_modules" ]; then
  echo "Installing web dependencies (one-time setup)..."
  (cd "$PROJECT_ROOT/web" && npm install --no-audit --no-fund --prefer-offline) || {
    echo "Error: npm install failed in web/. See output above."
    exit 1
  }
fi

# ── Start Vite dev server ──

echo "Starting Vite on port $VITE_PORT..."
cd "$PROJECT_ROOT/web"
# --host 127.0.0.1: Vite + Node 17+ default to binding the `localhost`
# alias, which on macOS resolves to ::1 (IPv6) only — IPv4 connects
# to 127.0.0.1:$VITE_PORT then get "connection refused". The
# alchemist-desktop's start_dev_server polls IPv4 (TcpStream::connect
# 127.0.0.1) and would hang for the full 240s timeout, leaving the
# operator's agent stuck on `start_dev_server RUNNING...`. Pinning
# the host to IPv4 localhost matches what the probe expects and
# doesn't expose Vite to the network. Don't change this to 0.0.0.0
# (would expose to LAN) or to `localhost` (back to the dual-stack
# trap).
npx vite --port "$VITE_PORT" --host 127.0.0.1 --strictPort > "$PROJECT_ROOT/.scratch/logs/vite.log" 2>&1 &
PIDS+=($!)
cd "$PROJECT_ROOT"

# ── Wait a moment and verify processes are alive ──

sleep 2

for pid in "${PIDS[@]}"; do
  if ! kill -0 "$pid" 2>/dev/null; then
    echo "Error: A background process failed to start. Check logs in .scratch/logs/"
    exit 1
  fi
done

echo ""
echo "============================================"
echo "  Dev stack running"
echo "============================================"
echo "  Vite SPA:   http://localhost:$VITE_PORT"
echo "  Deno API:   http://localhost:$API_PORT"
echo "  PostgreSQL: localhost:$DB_PORT"
echo ""
echo "  Logs:"
echo "    API:  .scratch/logs/server.log"
echo "    Vite: .scratch/logs/vite.log"
echo ""
echo "  Press Ctrl+C to stop."
echo "============================================"
echo ""

# ── Wait for any child to exit ──

wait
