#!/usr/bin/env bash
set -euo pipefail

# ===========================================================================
# provision.sh — Provision a new tenant in the shared Alchemist platform
#
# Creates the tenant's isolated Postgres schema, applies migrations,
# sets up Grafana monitoring, and optionally creates a GitHub repo from
# the template.
#
# Called once per customer at signup time by the Alchemist platform.
#
# Usage:
#   ./scripts/provision.sh \
#     --tenant-id   <uuid>       \
#     --app-slug    <string>     \
#     --db-url      <string>     \
#     --loki-url    <string>     \
#     --grafana-url <string>     \
#     --grafana-token <string>   \
#     --dispatcher-url <string>  \
#     --dispatcher-token <string> \
#     [--dry-run]
# ===========================================================================

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# ── Color codes ──

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
BOLD='\033[1m'
NC='\033[0m' # No Color

# ── Logging helpers ──

timestamp() {
  date -u '+%Y-%m-%dT%H:%M:%SZ'
}

log_step() {
  echo -e "${BOLD}[$(timestamp)]${NC} $1"
}

log_ok() {
  echo -e "${GREEN}[$(timestamp)] OK:${NC} $1"
}

log_warn() {
  echo -e "${YELLOW}[$(timestamp)] WARN:${NC} $1"
}

log_err() {
  echo -e "${RED}[$(timestamp)] ERROR:${NC} $1" >&2
}

# ── Parse arguments ──

TENANT_ID=""
APP_SLUG=""
DB_URL=""
LOKI_URL=""
GRAFANA_URL=""
GRAFANA_TOKEN=""
DISPATCHER_URL=""
DISPATCHER_TOKEN=""
DRY_RUN=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --tenant-id)        TENANT_ID="$2";        shift 2 ;;
    --app-slug)         APP_SLUG="$2";         shift 2 ;;
    --db-url)           DB_URL="$2";           shift 2 ;;
    --loki-url)         LOKI_URL="$2";         shift 2 ;;
    --grafana-url)      GRAFANA_URL="$2";      shift 2 ;;
    --grafana-token)    GRAFANA_TOKEN="$2";    shift 2 ;;
    --dispatcher-url)   DISPATCHER_URL="$2";   shift 2 ;;
    --dispatcher-token) DISPATCHER_TOKEN="$2"; shift 2 ;;
    --dry-run)          DRY_RUN=true;          shift ;;
    -h|--help)
      echo "Usage: ./scripts/provision.sh \\"
      echo "  --tenant-id   <uuid>       Alchemist-assigned tenant ID"
      echo "  --app-slug    <string>     URL-safe project slug (e.g., acme-saas)"
      echo "  --db-url      <string>     Shared Postgres connection string (admin)"
      echo "  --loki-url    <string>     Shared Loki push URL"
      echo "  --grafana-url <string>     Grafana API URL"
      echo "  --grafana-token <string>   Grafana service account token"
      echo "  --dispatcher-url <string>  Alchemist dispatcher webhook URL"
      echo "  --dispatcher-token <string> Dispatcher auth token"
      echo "  [--dry-run]                Print what would happen, do nothing"
      exit 0
      ;;
    *)
      log_err "Unknown argument: $1"
      exit 1
      ;;
  esac
done

# ── Validate required arguments ──

MISSING_ARGS=()
[[ -z "$TENANT_ID" ]]        && MISSING_ARGS+=("--tenant-id")
[[ -z "$APP_SLUG" ]]         && MISSING_ARGS+=("--app-slug")
[[ -z "$DB_URL" ]]           && MISSING_ARGS+=("--db-url")
[[ -z "$LOKI_URL" ]]         && MISSING_ARGS+=("--loki-url")
[[ -z "$GRAFANA_URL" ]]      && MISSING_ARGS+=("--grafana-url")
[[ -z "$GRAFANA_TOKEN" ]]    && MISSING_ARGS+=("--grafana-token")
[[ -z "$DISPATCHER_URL" ]]   && MISSING_ARGS+=("--dispatcher-url")
[[ -z "$DISPATCHER_TOKEN" ]] && MISSING_ARGS+=("--dispatcher-token")

if [[ ${#MISSING_ARGS[@]} -gt 0 ]]; then
  log_err "Missing required arguments: ${MISSING_ARGS[*]}"
  echo ""
  echo "Run with --help for usage."
  exit 1
fi

# ── Validate formats ──

UUID_RE='^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
if ! [[ "$TENANT_ID" =~ $UUID_RE ]]; then
  log_err "Invalid --tenant-id format: must be a valid UUID (e.g., 550e8400-e29b-41d4-a716-446655440000)"
  exit 1
fi

SLUG_RE='^[a-z0-9][a-z0-9-]*[a-z0-9]$'
# Allow single-character slugs too
SLUG_RE_SHORT='^[a-z0-9]$'
if ! [[ "$APP_SLUG" =~ $SLUG_RE || "$APP_SLUG" =~ $SLUG_RE_SHORT ]]; then
  log_err "Invalid --app-slug format: must be lowercase alphanumeric with hyphens (e.g., acme-saas)"
  exit 1
fi

# Slugs must not start or end with hyphens (already enforced by regex), and
# must not be excessively long (Postgres identifier limit is 63 chars, and
# we prefix with "tenant_" which adds 7).
if [[ ${#APP_SLUG} -gt 50 ]]; then
  log_err "Invalid --app-slug: max 50 characters (got ${#APP_SLUG})"
  exit 1
fi

# ── Derived values ──

# Convert hyphens to underscores for valid Postgres identifier
SCHEMA_NAME="tenant_$(echo "$APP_SLUG" | tr '-' '_')"
APP_ROLE="${SCHEMA_NAME}_app"
REPO_NAME="alchemist-ai/${APP_SLUG}"
PROVISIONED_AT="$(date -u '+%Y-%m-%dT%H:%M:%SZ')"

# ── Check prerequisites ──

if ! command -v psql &>/dev/null; then
  log_err "psql is required but not found. Install PostgreSQL client tools."
  exit 1
fi

if ! command -v curl &>/dev/null; then
  log_err "curl is required but not found."
  exit 1
fi

# ── State tracking for rollback ──

SCHEMA_CREATED=false
GRAFANA_FOLDER_UID=""
REPO_CREATED=false

rollback() {
  log_err "Provisioning failed. Starting rollback..."

  if [[ "$DRY_RUN" == true ]]; then
    log_step "[DRY RUN] Would rollback all changes"
    return
  fi

  # Drop schema if created
  if [[ "$SCHEMA_CREATED" == true ]]; then
    log_step "Dropping schema ${SCHEMA_NAME}..."
    psql "$DB_URL" -c "DROP SCHEMA IF EXISTS ${SCHEMA_NAME} CASCADE;" 2>/dev/null || true
    # Drop the app role if created
    psql "$DB_URL" -c "DROP ROLE IF EXISTS ${APP_ROLE};" 2>/dev/null || true
    log_ok "Schema dropped."
  fi

  # Delete Grafana folder if created
  if [[ -n "$GRAFANA_FOLDER_UID" ]]; then
    log_step "Deleting Grafana folder..."
    curl -s -X DELETE \
      -H "Authorization: Bearer ${GRAFANA_TOKEN}" \
      "${GRAFANA_URL}/api/folders/${GRAFANA_FOLDER_UID}" >/dev/null 2>&1 || true
    log_ok "Grafana folder deleted."
  fi

  # Delete GitHub repo if created
  if [[ "$REPO_CREATED" == true ]]; then
    log_step "Deleting GitHub repo ${REPO_NAME}..."
    gh repo delete "$REPO_NAME" --yes 2>/dev/null || true
    log_ok "GitHub repo deleted."
  fi

  log_err "Rollback complete."
}

# Trap to rollback on any failure after this point
trap 'rollback' ERR

# ── Print plan ──

echo ""
echo "============================================"
echo "  Alchemist Tenant Provisioning"
echo "============================================"
echo ""
echo "  Tenant ID:    ${TENANT_ID}"
echo "  App slug:     ${APP_SLUG}"
echo "  Schema:       ${SCHEMA_NAME}"
echo "  App role:     ${APP_ROLE}"
echo "  DB URL:       [REDACTED]"
echo "  Loki URL:     ${LOKI_URL}"
echo "  Grafana URL:  ${GRAFANA_URL}"
echo "  Dispatcher:   [REDACTED]"
echo "  Dry run:      ${DRY_RUN}"
echo ""

# ===========================================================================
# Step 1: Create tenant schema
# ===========================================================================

log_step "Step 1: Creating tenant schema '${SCHEMA_NAME}'..."

# Build the schema SQL using a temp file to avoid shell quoting issues
# with PL/pgSQL dollar-quoting ($body$...$body$).
# The heredoc is quoted ('SCHEMASQL') to prevent variable expansion, then
# sed substitutes the actual values.
SCHEMA_SQL_FILE="$(mktemp)"

cat > "$SCHEMA_SQL_FILE" <<'SCHEMASQL'
-- Create the tenant schema
CREATE SCHEMA IF NOT EXISTS __SCHEMA__;

-- Create an unprivileged app role for this tenant (if it doesn't exist)
DO $body$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = '__ROLE__') THEN
    CREATE ROLE __ROLE__ LOGIN;
  END IF;
END
$body$;

-- Grant usage on the schema to the app role
GRANT USAGE ON SCHEMA __SCHEMA__ TO __ROLE__;

-- Set default privileges so future tables are accessible
ALTER DEFAULT PRIVILEGES IN SCHEMA __SCHEMA__
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO __ROLE__;

ALTER DEFAULT PRIVILEGES IN SCHEMA __SCHEMA__
  GRANT USAGE, SELECT ON SEQUENCES TO __ROLE__;
SCHEMASQL

# Substitute placeholders with actual values
sed -i.bak "s/__SCHEMA__/${SCHEMA_NAME}/g; s/__ROLE__/${APP_ROLE}/g" "$SCHEMA_SQL_FILE"
rm -f "${SCHEMA_SQL_FILE}.bak"

if [[ "$DRY_RUN" == true ]]; then
  log_step "[DRY RUN] Would execute SQL:"
  cat "$SCHEMA_SQL_FILE"
  echo ""
else
  psql "$DB_URL" -f "$SCHEMA_SQL_FILE"
  SCHEMA_CREATED=true
  log_ok "Schema '${SCHEMA_NAME}' created with role '${APP_ROLE}'."
fi
rm -f "$SCHEMA_SQL_FILE"

# ===========================================================================
# Step 2: Apply migrations into tenant schema
# ===========================================================================

log_step "Step 2: Applying migrations into '${SCHEMA_NAME}'..."

MIGRATIONS_DIR="${PROJECT_ROOT}/db/migrations"

if [[ ! -d "$MIGRATIONS_DIR" ]]; then
  log_err "Migrations directory not found: ${MIGRATIONS_DIR}"
  exit 1
fi

# Collect migration files in sorted order
MIGRATION_FILES=()
while IFS= read -r -d '' file; do
  MIGRATION_FILES+=("$file")
done < <(find "$MIGRATIONS_DIR" -name '*.sql' -type f -print0 | sort -z)

if [[ ${#MIGRATION_FILES[@]} -eq 0 ]]; then
  log_warn "No migration files found in ${MIGRATIONS_DIR}."
else
  # Create the migrations tracking table inside the tenant schema
  TRACKING_SQL="SET search_path TO ${SCHEMA_NAME};
CREATE TABLE IF NOT EXISTS schema_migrations (
  version VARCHAR(255) PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);"

  if [[ "$DRY_RUN" == true ]]; then
    log_step "[DRY RUN] Would create schema_migrations table in ${SCHEMA_NAME}"
    log_step "[DRY RUN] Would apply ${#MIGRATION_FILES[@]} migration(s):"
    for mig_file in "${MIGRATION_FILES[@]}"; do
      mig_version="$(basename "$mig_file" .sql)"
      echo "  - ${mig_version}"
    done
    echo ""
  else
    psql "$DB_URL" -c "$TRACKING_SQL"

    APPLIED=0

    for mig_file in "${MIGRATION_FILES[@]}"; do
      mig_version="$(basename "$mig_file" .sql)"

      log_step "  Applying: ${mig_version}"

      # Build a temp file with the migration wrapped in a transaction.
      # We use a temp file instead of shell string interpolation because
      # migration SQL can contain dollar-quoting ($$), backticks, and
      # other shell metacharacters that break double-quoted strings.
      MIG_TMP="$(mktemp)"
      {
        echo "BEGIN;"
        echo "SET LOCAL search_path TO ${SCHEMA_NAME}, public;"
        cat "$mig_file"
        echo ""
        echo "INSERT INTO ${SCHEMA_NAME}.schema_migrations (version) VALUES ('${mig_version}');"
        echo "COMMIT;"
      } > "$MIG_TMP"

      if psql "$DB_URL" -v ON_ERROR_STOP=1 -f "$MIG_TMP" 2>&1; then
        log_ok "  Applied: ${mig_version}"
        APPLIED=$((APPLIED + 1))
      else
        rm -f "$MIG_TMP"
        log_err "  Failed to apply: ${mig_version}"
        log_err "  Schema will be dropped during rollback."
        exit 1
      fi
      rm -f "$MIG_TMP"
    done

    log_ok "Applied ${APPLIED} migration(s) to '${SCHEMA_NAME}'."
  fi
fi

# ===========================================================================
# Step 3: Connection limits (PgBouncer config fragment)
# ===========================================================================

log_step "Step 3: Generating PgBouncer connection limit config..."

PGBOUNCER_FRAGMENT=$(cat <<EOF
; PgBouncer pool configuration for tenant: ${APP_SLUG}
; Add this to your [databases] and [pools] sections.
;
; [databases]
; ${APP_SLUG} = host=<pg-host> port=5432 dbname=<dbname>
;
; Pool limit for tenant app role
; Max 5 connections per tenant to prevent noisy-neighbor issues.
[pools]
${APP_ROLE} = pool_size=5 max_db_connections=5 reserve_pool_size=1
EOF
)

if [[ "$DRY_RUN" == true ]]; then
  log_step "[DRY RUN] Would output PgBouncer config fragment"
fi

echo ""
echo "--- PgBouncer Config Fragment ---"
echo "$PGBOUNCER_FRAGMENT"
echo "--- End PgBouncer Config ---"
echo ""
log_ok "Add the above to PgBouncer config for tenant '${APP_SLUG}'."

# ===========================================================================
# Step 4: Create GitHub repository from template
# ===========================================================================

log_step "Step 4: Creating GitHub repository..."

if [[ -z "${GITHUB_TOKEN:-}" ]]; then
  log_warn "GITHUB_TOKEN not set. Skipping GitHub repo creation."
  log_warn "Create the repo manually: gh repo create ${REPO_NAME} --template alchemist-ai/alchemist-template --private"
  REPO_URL=""
elif [[ "$DRY_RUN" == true ]]; then
  log_step "[DRY RUN] Would create private repo: ${REPO_NAME} from template alchemist-ai/alchemist-template"
  REPO_URL="https://github.com/${REPO_NAME}"
else
  if ! command -v gh &>/dev/null; then
    log_warn "GitHub CLI (gh) not found. Skipping repo creation."
    log_warn "Install: https://cli.github.com/"
    REPO_URL=""
  else
    log_step "  Creating ${REPO_NAME} from template..."
    gh repo create "$REPO_NAME" \
      --template "alchemist-ai/alchemist-template" \
      --private \
      --confirm 2>&1 || {
      log_warn "Failed to create GitHub repo. Continuing without it."
      REPO_URL=""
    }
    if [[ -z "${REPO_URL:-}" ]]; then
      REPO_URL="https://github.com/${REPO_NAME}"
      REPO_CREATED=true
      log_ok "Repository created: ${REPO_URL}"
    fi
  fi
fi

# ===========================================================================
# Step 5: Provision Grafana monitoring
# ===========================================================================

log_step "Step 5: Provisioning Grafana monitoring..."

GRAFANA_FOLDER_ID=""

# -- 5a: Create Grafana folder --

FOLDER_PAYLOAD=$(cat <<JSON
{
  "title": "Tenant: ${APP_SLUG}",
  "uid": "tenant-${APP_SLUG}"
}
JSON
)

if [[ "$DRY_RUN" == true ]]; then
  log_step "[DRY RUN] Would create Grafana folder:"
  echo "  POST ${GRAFANA_URL}/api/folders"
  echo "  ${FOLDER_PAYLOAD}"
  GRAFANA_FOLDER_ID=0
  GRAFANA_FOLDER_UID="tenant-${APP_SLUG}"
else
  FOLDER_RESPONSE=$(curl -s -w "\n%{http_code}" \
    -X POST \
    -H "Authorization: Bearer ${GRAFANA_TOKEN}" \
    -H "Content-Type: application/json" \
    -d "$FOLDER_PAYLOAD" \
    "${GRAFANA_URL}/api/folders")

  FOLDER_HTTP_CODE=$(echo "$FOLDER_RESPONSE" | tail -1)
  FOLDER_BODY=$(echo "$FOLDER_RESPONSE" | sed '$d')

  if [[ "$FOLDER_HTTP_CODE" == "200" || "$FOLDER_HTTP_CODE" == "201" ]]; then
    GRAFANA_FOLDER_ID=$(echo "$FOLDER_BODY" | grep -o '"id":[0-9]*' | head -1 | cut -d: -f2)
    GRAFANA_FOLDER_UID=$(echo "$FOLDER_BODY" | grep -o '"uid":"[^"]*"' | head -1 | cut -d'"' -f4)
    log_ok "Grafana folder created: id=${GRAFANA_FOLDER_ID}, uid=${GRAFANA_FOLDER_UID}"
  elif [[ "$FOLDER_HTTP_CODE" == "409" ]]; then
    # Folder already exists -- look it up
    log_warn "Grafana folder 'tenant-${APP_SLUG}' already exists. Using existing."
    EXISTING=$(curl -s \
      -H "Authorization: Bearer ${GRAFANA_TOKEN}" \
      "${GRAFANA_URL}/api/folders/tenant-${APP_SLUG}")
    GRAFANA_FOLDER_ID=$(echo "$EXISTING" | grep -o '"id":[0-9]*' | head -1 | cut -d: -f2)
    GRAFANA_FOLDER_UID="tenant-${APP_SLUG}"
  else
    log_err "Failed to create Grafana folder (HTTP ${FOLDER_HTTP_CODE}):"
    echo "$FOLDER_BODY" >&2
    exit 1
  fi
fi

# -- 5b: Upload tenant-health dashboard --

DASHBOARD_FILE="${PROJECT_ROOT}/monitoring/grafana/dashboards/tenant-health.json"

if [[ -f "$DASHBOARD_FILE" ]]; then
  # Substitute template variables in the dashboard JSON
  DASHBOARD_JSON=$(cat "$DASHBOARD_FILE" \
    | sed "s/\${tenant_id}/${TENANT_ID}/g" \
    | sed "s/\${app_slug}/${APP_SLUG}/g")

  # Wrap in the Grafana import payload
  DASHBOARD_PAYLOAD=$(cat <<JSON
{
  "dashboard": ${DASHBOARD_JSON},
  "folderUid": "${GRAFANA_FOLDER_UID}",
  "overwrite": true
}
JSON
)

  if [[ "$DRY_RUN" == true ]]; then
    log_step "[DRY RUN] Would upload dashboard from ${DASHBOARD_FILE}"
    log_step "[DRY RUN]   with tenant_id=${TENANT_ID}, app_slug=${APP_SLUG}"
  else
    DASH_RESPONSE=$(curl -s -w "\n%{http_code}" \
      -X POST \
      -H "Authorization: Bearer ${GRAFANA_TOKEN}" \
      -H "Content-Type: application/json" \
      -d "$DASHBOARD_PAYLOAD" \
      "${GRAFANA_URL}/api/dashboards/db")

    DASH_HTTP_CODE=$(echo "$DASH_RESPONSE" | tail -1)
    if [[ "$DASH_HTTP_CODE" == "200" || "$DASH_HTTP_CODE" == "201" ]]; then
      log_ok "Dashboard uploaded: tenant-health"
    else
      DASH_BODY=$(echo "$DASH_RESPONSE" | sed '$d')
      log_err "Failed to upload dashboard (HTTP ${DASH_HTTP_CODE}):"
      echo "$DASH_BODY" >&2
      exit 1
    fi
  fi
else
  log_warn "Dashboard file not found: ${DASHBOARD_FILE}. Skipping."
fi

# -- 5c: Upload alert rules --

ALERTS_DIR="${PROJECT_ROOT}/monitoring/grafana/alerts"

if [[ -d "$ALERTS_DIR" ]]; then
  ALERT_COUNT=0
  for alert_file in "$ALERTS_DIR"/*.yml "$ALERTS_DIR"/*.yaml; do
    [[ -f "$alert_file" ]] || continue
    alert_name="$(basename "$alert_file")"

    # Substitute tenant_id in LogQL queries
    ALERT_CONTENT=$(cat "$alert_file" \
      | sed "s/\${tenant_id}/${TENANT_ID}/g" \
      | sed "s/\${app_slug}/${APP_SLUG}/g")

    if [[ "$DRY_RUN" == true ]]; then
      log_step "[DRY RUN] Would upload alert rule: ${alert_name}"
    else
      ALERT_RESPONSE=$(curl -s -w "\n%{http_code}" \
        -X POST \
        -H "Authorization: Bearer ${GRAFANA_TOKEN}" \
        -H "Content-Type: application/yaml" \
        -d "$ALERT_CONTENT" \
        "${GRAFANA_URL}/api/v1/provisioning/alert-rules")

      ALERT_HTTP_CODE=$(echo "$ALERT_RESPONSE" | tail -1)
      if [[ "$ALERT_HTTP_CODE" == "200" || "$ALERT_HTTP_CODE" == "201" || "$ALERT_HTTP_CODE" == "202" ]]; then
        log_ok "Alert rule uploaded: ${alert_name}"
      else
        ALERT_BODY=$(echo "$ALERT_RESPONSE" | sed '$d')
        log_warn "Failed to upload alert rule ${alert_name} (HTTP ${ALERT_HTTP_CODE}): ${ALERT_BODY}"
        # Non-fatal: continue with other alerts
      fi
    fi
    ALERT_COUNT=$((ALERT_COUNT + 1))
  done

  if [[ $ALERT_COUNT -eq 0 ]]; then
    log_warn "No alert rule files found in ${ALERTS_DIR}/."
  fi
else
  log_warn "Alerts directory not found: ${ALERTS_DIR}. Skipping."
fi

# -- 5d: Create contact point for Alchemist dispatcher --

CONTACT_POINT_FILE="${PROJECT_ROOT}/monitoring/grafana/contact-points/alchemist-dispatcher.yml"

if [[ -f "$CONTACT_POINT_FILE" ]]; then
  CONTACT_CONTENT=$(cat "$CONTACT_POINT_FILE" \
    | sed "s|\${dispatcher_url}|${DISPATCHER_URL}|g" \
    | sed "s|\${dispatcher_token}|${DISPATCHER_TOKEN}|g" \
    | sed "s/\${tenant_id}/${TENANT_ID}/g" \
    | sed "s/\${app_slug}/${APP_SLUG}/g")

  if [[ "$DRY_RUN" == true ]]; then
    log_step "[DRY RUN] Would create contact point from ${CONTACT_POINT_FILE}"
    log_step "[DRY RUN]   with dispatcher_url=[REDACTED], dispatcher_token=[REDACTED]"
  else
    CP_RESPONSE=$(curl -s -w "\n%{http_code}" \
      -X POST \
      -H "Authorization: Bearer ${GRAFANA_TOKEN}" \
      -H "Content-Type: application/yaml" \
      -d "$CONTACT_CONTENT" \
      "${GRAFANA_URL}/api/v1/provisioning/contact-points")

    CP_HTTP_CODE=$(echo "$CP_RESPONSE" | tail -1)
    if [[ "$CP_HTTP_CODE" == "200" || "$CP_HTTP_CODE" == "201" || "$CP_HTTP_CODE" == "202" ]]; then
      log_ok "Contact point created: alchemist-dispatcher"
    else
      CP_BODY=$(echo "$CP_RESPONSE" | sed '$d')
      log_warn "Failed to create contact point (HTTP ${CP_HTTP_CODE}): ${CP_BODY}"
    fi
  fi
else
  log_warn "Contact point file not found: ${CONTACT_POINT_FILE}. Skipping."
fi

log_ok "Grafana monitoring provisioned for tenant '${APP_SLUG}'."

# ===========================================================================
# Step 6: Output tenant config JSON
# ===========================================================================

log_step "Step 6: Writing tenant config..."

# Build the output JSON
TENANT_CONFIG=$(cat <<JSON
{
  "tenantId": "${TENANT_ID}",
  "appSlug": "${APP_SLUG}",
  "schemaName": "${SCHEMA_NAME}",
  "appRole": "${APP_ROLE}",
  "grafanaFolderId": ${GRAFANA_FOLDER_ID:-0},
  "grafanaFolderUid": "${GRAFANA_FOLDER_UID:-tenant-${APP_SLUG}}",
  "repoUrl": "${REPO_URL:-}",
  "provisionedAt": "${PROVISIONED_AT}"
}
JSON
)

echo ""
echo "--- Tenant Config (JSON) ---"
echo "$TENANT_CONFIG"
echo "--- End Tenant Config ---"
echo ""

# ── Clear the ERR trap (we succeeded) ──

trap - ERR

# ── Done ──

echo ""
echo -e "${GREEN}============================================${NC}"
echo -e "${GREEN}  Tenant '${APP_SLUG}' provisioned successfully${NC}"
echo -e "${GREEN}============================================${NC}"
echo ""
echo "  Schema:     ${SCHEMA_NAME}"
echo "  App role:   ${APP_ROLE}"
echo "  Grafana:    folder uid=${GRAFANA_FOLDER_UID:-tenant-${APP_SLUG}}"
[[ -n "${REPO_URL:-}" ]] && echo "  Repo:       ${REPO_URL}"
echo "  Timestamp:  ${PROVISIONED_AT}"
echo ""
