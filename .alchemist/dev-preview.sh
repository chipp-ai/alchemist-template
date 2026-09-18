#!/usr/bin/env bash
#
# Boot this project's full stack inside a Chipp Builder sandbox.
#
# The Builder reads `.alchemist/dev-server.json` and runs this from the repo
# root. Without it the Builder falls back to "find a dev script and run it",
# which starts the API with no database and no config, so every DB-backed page
# is empty and HubSpot-backed pages fall to their fixture branch.
#
# What this deliberately does NOT do: touch the project's real credentials. The
# sandbox gets its OWN Postgres (the sandbox image runs one, handed to us as
# SANDBOX_PG_USER / SANDBOX_PG_PASSWORD) and throwaway secrets. The deployment's
# DATABASE_URL and its third-party tokens never enter a sandbox: an agent runs
# in here, and a preview must never be able to write to live customer data.
# Anything needing a real vendor credential therefore stays in whatever
# preview or fixture mode the app already has; everything the app stores
# itself is real.
set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

API_PORT=8000
VITE_PORT=5173          # the port the Builder's preview tunnel reaches
DB_NAME=app_preview
PG_USER="${SANDBOX_PG_USER:-test}"
PG_PASS="${SANDBOX_PG_PASSWORD:-test}"
# The sandbox's Postgres is always on 5432; the override exists so this script
# can be exercised against any local Postgres without editing it.
PG_PORT="${SANDBOX_PG_PORT:-5432}"

export DATABASE_URL="postgres://${PG_USER}:${PG_PASS}@127.0.0.1:${PG_PORT}/${DB_NAME}"
export PORT="$API_PORT"
export APP_URL="http://localhost:${API_PORT}"
export WEB_APP_URL="http://localhost:${VITE_PORT}"
export NODE_ENV=development
export ALCHEMIST_DEV_ROUTES=1
# Preview-only, regenerated per boot. Never a value from the deployment.
PREVIEW_SECRET="preview-only-$(head -c 24 /dev/urandom | od -An -tx1 | tr -d ' \n')"
export JWT_SECRET="${JWT_SECRET:-$PREVIEW_SECRET}"
export SESSION_SECRET="${SESSION_SECRET:-$PREVIEW_SECRET}"

echo "[preview] database ${DB_NAME} on the sandbox's own Postgres"
# Create the database if it is not there yet. Uses the same npm:postgres client
# scripts/dev.sh uses, so this needs no psql/createdb binaries in the image.
DB_NAME="$DB_NAME" deno run --allow-net --allow-env - <<'TS'
const postgres = (await import("npm:postgres@3.4.5")).default;
const url = new URL(Deno.env.get("DATABASE_URL")!);
const name = Deno.env.get("DB_NAME")!;
url.pathname = "/postgres";
const meta = postgres(url.toString(), { max: 1, onnotice: () => {} });
try {
  const rows = await meta`SELECT 1 FROM pg_database WHERE datname = ${name}`;
  if (rows.length === 0) await meta.unsafe(`CREATE DATABASE "${name}"`);
} catch (e) {
  console.error("[preview] could not ensure the database:", e instanceof Error ? e.message : e);
} finally {
  await meta.end({ timeout: 5 });
}
TS

echo "[preview] migrating"
deno task db:migrate || echo "[preview] migrations failed -- the API may serve empty data"

# Demo seed: idempotent by contract, and deliberately NOT waited on. The API
# does not need it to boot, and a seed that hangs must never hold the preview
# hostage -- which is exactly what happened before scripts/seed-demo.ts learned
# to close its pool (a Deno process with an open Postgres connection never
# exits, so this script sat at the seed and never started the API).
# Backgrounded, its rows land seconds later, well before anyone looks.
echo "[preview] seeding demo data in the background"
deno run --env --allow-all scripts/seed-demo.ts > /tmp/chipp-preview-seed.log 2>&1 &
SEED_PID=$!

echo "[preview] starting the API on ${API_PORT}"
deno task dev &
API_PID=$!
trap 'kill "$API_PID" "$SEED_PID" 2>/dev/null || true' EXIT INT TERM

if [ ! -d web/node_modules ]; then
  echo "[preview] installing web dependencies (first boot only)"
  (cd web && npm install --no-audit --no-fund --prefer-offline) || {
    echo "[preview] npm install failed in web/"
    exit 1
  }
fi

cd web
export VITE_API_PROXY="http://localhost:${API_PORT}"
echo "[preview] starting Vite on ${VITE_PORT}"
# --host: the preview tunnel reaches the sandbox interface, not loopback.
# --strictPort: fail loudly rather than drift to a port the preview cannot see.
exec npx vite --host "${SANDBOX_VITE_HOST:-0.0.0.0}" --port "$VITE_PORT" --strictPort
