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

# ── Create log directory ──

mkdir -p "$PROJECT_ROOT/.scratch/logs"

# ── Track background PIDs for cleanup ──

PIDS=()

cleanup() {
  echo ""
  echo "Shutting down dev stack..."
  for pid in "${PIDS[@]}"; do
    if kill -0 "$pid" 2>/dev/null; then
      kill "$pid" 2>/dev/null || true
    fi
  done
  # Wait briefly, then force-kill stragglers
  sleep 1
  for pid in "${PIDS[@]}"; do
    if kill -0 "$pid" 2>/dev/null; then
      kill -9 "$pid" 2>/dev/null || true
    fi
  done
  echo "Dev stack stopped."
}

trap cleanup SIGINT SIGTERM EXIT

# ── Check Docker is running ──

if ! docker info >/dev/null 2>&1; then
  echo "Error: Docker is not running. Start Docker Desktop and try again."
  exit 1
fi

# ── Start docker-compose services if not running ──

echo "Checking Docker services..."
cd "$PROJECT_ROOT"

if ! docker compose ps --status running 2>/dev/null | grep -q "postgres"; then
  echo "Starting Docker services (postgres, redis)..."
  docker compose up -d
  echo "Docker services started."
else
  echo "Docker services already running."
fi

# ── Wait for PostgreSQL ──

echo "Waiting for PostgreSQL on port $DB_PORT..."
RETRIES=0
MAX_RETRIES=30
while ! pg_isready -h localhost -p "$DB_PORT" -q 2>/dev/null; do
  RETRIES=$((RETRIES + 1))
  if [[ $RETRIES -ge $MAX_RETRIES ]]; then
    echo "Error: PostgreSQL not ready after ${MAX_RETRIES}s on port $DB_PORT."
    echo "Check: docker compose logs postgres"
    exit 1
  fi
  sleep 1
done
echo "PostgreSQL is ready."

# ── Run migrations ──

echo "Running database migrations..."
cd "$PROJECT_ROOT"
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

# ── Start Vite dev server ──

echo "Starting Vite on port $VITE_PORT..."
cd "$PROJECT_ROOT/web"
npx vite --port "$VITE_PORT" --strictPort > "$PROJECT_ROOT/.scratch/logs/vite.log" 2>&1 &
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
