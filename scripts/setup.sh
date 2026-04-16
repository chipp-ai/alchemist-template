#!/usr/bin/env bash
set -euo pipefail

# ===========================================================================
# setup.sh — First-time project setup
#
# Checks prerequisites, installs dependencies, starts Docker services,
# runs database migrations.
#
# Usage:
#   ./scripts/setup.sh
# ===========================================================================

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

echo ""
echo "============================================"
echo "  Alchemist Template — First-Time Setup"
echo "============================================"
echo ""

# ── Check required tools ──

MISSING=()

check_tool() {
  if ! command -v "$1" &>/dev/null; then
    MISSING+=("$1")
  fi
}

check_tool "deno"
check_tool "docker"
check_tool "git"
check_tool "node"

if [[ ${#MISSING[@]} -gt 0 ]]; then
  echo "Error: Missing required tools: ${MISSING[*]}"
  echo ""
  echo "Install instructions:"
  for tool in "${MISSING[@]}"; do
    case "$tool" in
      deno)   echo "  deno:   curl -fsSL https://deno.land/install.sh | sh" ;;
      docker) echo "  docker: https://docs.docker.com/get-docker/" ;;
      git)    echo "  git:    https://git-scm.com/downloads" ;;
      node)   echo "  node:   https://nodejs.org/ (needed for web/ dependencies)" ;;
    esac
  done
  exit 1
fi

echo "All required tools found:"
echo "  deno:   $(deno --version | head -1)"
echo "  docker: $(docker --version)"
echo "  git:    $(git --version)"
echo "  node:   $(node --version)"
echo ""

# ── Copy .env.example to .env if needed ──

if [[ ! -f "$PROJECT_ROOT/.env" ]]; then
  echo "Creating .env from .env.example..."
  cp "$PROJECT_ROOT/.env.example" "$PROJECT_ROOT/.env"
  echo "  Created .env — review and customize it before running."
else
  echo ".env already exists, skipping."
fi
echo ""

# ── Create scratch directories ──

mkdir -p "$PROJECT_ROOT/.scratch/logs"

# ── Install web dependencies ──

echo "Installing web dependencies..."
cd "$PROJECT_ROOT/web"
npm install
cd "$PROJECT_ROOT"
echo ""

# ── Start Docker services ──

if ! docker info >/dev/null 2>&1; then
  echo "Error: Docker is not running. Start Docker Desktop and try again."
  exit 1
fi

echo "Starting Docker services (postgres, redis)..."
cd "$PROJECT_ROOT"
docker compose up -d
echo ""

# ── Wait for PostgreSQL ──

DB_PORT="${DB_PORT:-5432}"
if [[ -f "$PROJECT_ROOT/.env" ]]; then
  _db_port=$(grep -E '^DB_PORT=' "$PROJECT_ROOT/.env" 2>/dev/null | head -1 | cut -d= -f2)
  if [[ -n "${_db_port:-}" ]]; then
    DB_PORT="$_db_port"
  fi
fi

echo "Waiting for PostgreSQL on port $DB_PORT..."
RETRIES=0
MAX_RETRIES=30
while ! pg_isready -h localhost -p "$DB_PORT" -q 2>/dev/null; do
  RETRIES=$((RETRIES + 1))
  if [[ $RETRIES -ge $MAX_RETRIES ]]; then
    echo "Error: PostgreSQL not ready after ${MAX_RETRIES}s."
    echo "Check: docker compose logs postgres"
    exit 1
  fi
  sleep 1
done
echo "PostgreSQL is ready."
echo ""

# ── Run database migrations ──

echo "Running database migrations..."
deno task db:migrate
echo ""

# ── Done ──

echo "============================================"
echo "  Setup complete!"
echo "============================================"
echo ""
echo "  Next steps:"
echo ""
echo "  1. Review and customize .env"
echo "  2. Start the dev stack:"
echo "     ./scripts/dev.sh --api-port 8000 --port 5173"
echo ""
echo "  3. Open http://localhost:5173 in your browser"
echo ""
