#!/usr/bin/env bash
set -euo pipefail

# ===========================================================================
# deprovision.sh — Tear down a tenant from the shared Alchemist platform
#
# Drops the tenant's Postgres schema, deletes Grafana monitoring, and
# optionally deletes the GitHub repository. Requires --confirm to prevent
# accidental destruction.
#
# Usage:
#   ./scripts/deprovision.sh \
#     --tenant-id      <uuid>   \
#     --app-slug       <string> \
#     --db-url         <string> \
#     --grafana-url    <string> \
#     --grafana-token  <string> \
#     --confirm                 \
#     [--delete-repo]           \
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
GRAFANA_URL=""
GRAFANA_TOKEN=""
CONFIRM=false
DELETE_REPO=false
DRY_RUN=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --tenant-id)      TENANT_ID="$2";      shift 2 ;;
    --app-slug)       APP_SLUG="$2";       shift 2 ;;
    --db-url)         DB_URL="$2";         shift 2 ;;
    --grafana-url)    GRAFANA_URL="$2";    shift 2 ;;
    --grafana-token)  GRAFANA_TOKEN="$2";  shift 2 ;;
    --confirm)        CONFIRM=true;        shift ;;
    --delete-repo)    DELETE_REPO=true;    shift ;;
    --dry-run)        DRY_RUN=true;        shift ;;
    -h|--help)
      echo "Usage: ./scripts/deprovision.sh \\"
      echo "  --tenant-id      <uuid>   Alchemist-assigned tenant ID"
      echo "  --app-slug       <string> URL-safe project slug"
      echo "  --db-url         <string> Shared Postgres connection string (admin)"
      echo "  --grafana-url    <string> Grafana API URL"
      echo "  --grafana-token  <string> Grafana service account token"
      echo "  --confirm                 Required flag to prevent accidental destruction"
      echo "  [--delete-repo]           Also delete the GitHub repository"
      echo "  [--dry-run]               Print what would happen, do nothing"
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
[[ -z "$TENANT_ID" ]]     && MISSING_ARGS+=("--tenant-id")
[[ -z "$APP_SLUG" ]]      && MISSING_ARGS+=("--app-slug")
[[ -z "$DB_URL" ]]        && MISSING_ARGS+=("--db-url")
[[ -z "$GRAFANA_URL" ]]   && MISSING_ARGS+=("--grafana-url")
[[ -z "$GRAFANA_TOKEN" ]] && MISSING_ARGS+=("--grafana-token")

if [[ ${#MISSING_ARGS[@]} -gt 0 ]]; then
  log_err "Missing required arguments: ${MISSING_ARGS[*]}"
  echo ""
  echo "Run with --help for usage."
  exit 1
fi

if [[ "$CONFIRM" != true && "$DRY_RUN" != true ]]; then
  log_err "Refusing to deprovision without --confirm flag."
  echo ""
  echo "This operation is DESTRUCTIVE and IRREVERSIBLE."
  echo "It will:"
  echo "  - DROP the tenant schema and ALL its data (CASCADE)"
  echo "  - DELETE the tenant's Grafana dashboards and alerts"
  [[ "$DELETE_REPO" == true ]] && echo "  - DELETE the GitHub repository"
  echo ""
  echo "Add --confirm to proceed, or --dry-run to preview."
  exit 1
fi

# ── Validate formats ──

UUID_RE='^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
if ! [[ "$TENANT_ID" =~ $UUID_RE ]]; then
  log_err "Invalid --tenant-id format: must be a valid UUID"
  exit 1
fi

SLUG_RE='^[a-z0-9][a-z0-9-]*[a-z0-9]$'
SLUG_RE_SHORT='^[a-z0-9]$'
if ! [[ "$APP_SLUG" =~ $SLUG_RE || "$APP_SLUG" =~ $SLUG_RE_SHORT ]]; then
  log_err "Invalid --app-slug format: must be lowercase alphanumeric with hyphens"
  exit 1
fi

# ── Derived values ──

SCHEMA_NAME="tenant_$(echo "$APP_SLUG" | tr '-' '_')"
APP_ROLE="${SCHEMA_NAME}_app"
REPO_NAME="alchemist-ai/${APP_SLUG}"
GRAFANA_FOLDER_UID="tenant-${APP_SLUG}"

# ── Check prerequisites ──

if ! command -v psql &>/dev/null; then
  log_err "psql is required but not found."
  exit 1
fi

if ! command -v curl &>/dev/null; then
  log_err "curl is required but not found."
  exit 1
fi

# ── Print plan ──

echo ""
echo -e "${RED}============================================${NC}"
echo -e "${RED}  Alchemist Tenant DEPROVISIONING${NC}"
echo -e "${RED}============================================${NC}"
echo ""
echo "  Tenant ID:    ${TENANT_ID}"
echo "  App slug:     ${APP_SLUG}"
echo "  Schema:       ${SCHEMA_NAME} (will be DROPPED CASCADE)"
echo "  App role:     ${APP_ROLE} (will be DROPPED)"
echo "  DB URL:       [REDACTED]"
echo "  Grafana:      folder uid=${GRAFANA_FOLDER_UID} (will be DELETED)"
[[ "$DELETE_REPO" == true ]] && echo "  GitHub repo:  ${REPO_NAME} (will be DELETED)"
echo "  Dry run:      ${DRY_RUN}"
echo ""

# ===========================================================================
# Step 1: Drop tenant schema
# ===========================================================================

log_step "Step 1: Dropping schema '${SCHEMA_NAME}' (CASCADE)..."

if [[ "$DRY_RUN" == true ]]; then
  log_step "[DRY RUN] Would execute: DROP SCHEMA IF EXISTS ${SCHEMA_NAME} CASCADE;"
  log_step "[DRY RUN] Would execute: DROP ROLE IF EXISTS ${APP_ROLE};"
else
  # Check if schema exists before dropping
  SCHEMA_EXISTS=$(psql "$DB_URL" -t -c "SELECT 1 FROM information_schema.schemata WHERE schema_name = '${SCHEMA_NAME}';" 2>/dev/null | tr -d '[:space:]')

  if [[ "$SCHEMA_EXISTS" == "1" ]]; then
    psql "$DB_URL" -c "DROP SCHEMA ${SCHEMA_NAME} CASCADE;"
    log_ok "Schema '${SCHEMA_NAME}' dropped."
  else
    log_warn "Schema '${SCHEMA_NAME}' does not exist. Skipping."
  fi

  # Drop the app role
  ROLE_EXISTS=$(psql "$DB_URL" -t -c "SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = '${APP_ROLE}';" 2>/dev/null | tr -d '[:space:]')

  if [[ "$ROLE_EXISTS" == "1" ]]; then
    psql "$DB_URL" -c "DROP ROLE ${APP_ROLE};"
    log_ok "Role '${APP_ROLE}' dropped."
  else
    log_warn "Role '${APP_ROLE}' does not exist. Skipping."
  fi
fi

# ===========================================================================
# Step 2: Delete GitHub repository
# ===========================================================================

if [[ "$DELETE_REPO" == true ]]; then
  log_step "Step 2: Deleting GitHub repository '${REPO_NAME}'..."

  if [[ -z "${GITHUB_TOKEN:-}" ]]; then
    log_warn "GITHUB_TOKEN not set. Skipping repo deletion."
    log_warn "Delete manually: gh repo delete ${REPO_NAME} --yes"
  elif [[ "$DRY_RUN" == true ]]; then
    log_step "[DRY RUN] Would delete repo: ${REPO_NAME}"
  else
    if ! command -v gh &>/dev/null; then
      log_warn "GitHub CLI (gh) not found. Skipping repo deletion."
    else
      if gh repo delete "$REPO_NAME" --yes 2>&1; then
        log_ok "Repository '${REPO_NAME}' deleted."
      else
        log_warn "Failed to delete repo '${REPO_NAME}'. It may not exist or you lack permissions."
      fi
    fi
  fi
else
  log_step "Step 2: Skipping GitHub repo deletion (use --delete-repo to include)."
fi

# ===========================================================================
# Step 3: Delete Grafana folder (cascades dashboards and alerts)
# ===========================================================================

log_step "Step 3: Deleting Grafana folder '${GRAFANA_FOLDER_UID}' and all contents..."

if [[ "$DRY_RUN" == true ]]; then
  log_step "[DRY RUN] Would DELETE ${GRAFANA_URL}/api/folders/${GRAFANA_FOLDER_UID}?forceDeleteRules=true"
else
  # Check if folder exists
  FOLDER_CHECK=$(curl -s -o /dev/null -w "%{http_code}" \
    -H "Authorization: Bearer ${GRAFANA_TOKEN}" \
    "${GRAFANA_URL}/api/folders/${GRAFANA_FOLDER_UID}")

  if [[ "$FOLDER_CHECK" == "200" ]]; then
    # Delete the folder -- forceDeleteRules removes alert rules inside it
    DELETE_RESPONSE=$(curl -s -w "\n%{http_code}" \
      -X DELETE \
      -H "Authorization: Bearer ${GRAFANA_TOKEN}" \
      "${GRAFANA_URL}/api/folders/${GRAFANA_FOLDER_UID}?forceDeleteRules=true")

    DELETE_HTTP_CODE=$(echo "$DELETE_RESPONSE" | tail -1)
    if [[ "$DELETE_HTTP_CODE" == "200" || "$DELETE_HTTP_CODE" == "204" ]]; then
      log_ok "Grafana folder '${GRAFANA_FOLDER_UID}' and all dashboards/alerts deleted."
    else
      DELETE_BODY=$(echo "$DELETE_RESPONSE" | sed '$d')
      log_warn "Failed to delete Grafana folder (HTTP ${DELETE_HTTP_CODE}): ${DELETE_BODY}"
    fi
  elif [[ "$FOLDER_CHECK" == "404" ]]; then
    log_warn "Grafana folder '${GRAFANA_FOLDER_UID}' not found. Skipping."
  else
    log_warn "Could not check Grafana folder (HTTP ${FOLDER_CHECK}). Skipping."
  fi
fi

# -- 3b: Delete the tenant-specific contact point --

log_step "  Cleaning up contact point: alchemist-dispatcher-${APP_SLUG}..."

if [[ "$DRY_RUN" == true ]]; then
  log_step "[DRY RUN] Would delete contact point: alchemist-dispatcher-${APP_SLUG}"
else
  # Grafana provisioning API uses UID for contact points; try the conventional name
  CP_DELETE_RESPONSE=$(curl -s -o /dev/null -w "%{http_code}" \
    -X DELETE \
    -H "Authorization: Bearer ${GRAFANA_TOKEN}" \
    "${GRAFANA_URL}/api/v1/provisioning/contact-points/alchemist-dispatcher-${APP_SLUG}")

  if [[ "$CP_DELETE_RESPONSE" == "202" || "$CP_DELETE_RESPONSE" == "204" ]]; then
    log_ok "Contact point deleted."
  elif [[ "$CP_DELETE_RESPONSE" == "404" ]]; then
    log_warn "Contact point not found. May have been cleaned up with the folder."
  else
    log_warn "Contact point deletion returned HTTP ${CP_DELETE_RESPONSE}. Continuing."
  fi
fi

# ── Done ──

echo ""
echo -e "${GREEN}============================================${NC}"
echo -e "${GREEN}  Tenant '${APP_SLUG}' deprovisioned${NC}"
echo -e "${GREEN}============================================${NC}"
echo ""
echo "  Schema:       ${SCHEMA_NAME} -- dropped"
echo "  App role:     ${APP_ROLE} -- dropped"
echo "  Grafana:      ${GRAFANA_FOLDER_UID} -- deleted"
[[ "$DELETE_REPO" == true ]] && echo "  GitHub repo:  ${REPO_NAME} -- deleted"
echo "  Timestamp:    $(date -u '+%Y-%m-%dT%H:%M:%SZ')"
echo ""
