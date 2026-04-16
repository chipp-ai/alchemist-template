#!/usr/bin/env bash
set -euo pipefail

# ===========================================================================
# eject.sh — Hand a tenant's project back to them for independent ownership
#
# When a customer wants to take over their app and run it independently:
#   1. Exports their database schema as a portable SQL dump
#   2. Cleans Alchemist-specific config from the repo (env vars, monitoring,
#      CLAUDE.md branding, Promtail sidecar)
#   3. Transfers the GitHub repository to the customer's account/org
#   4. Deletes the tenant's Grafana monitoring and contact points
#   5. Writes a self-hosting guide into the output directory
#
# What the customer gets:
#   - Their full codebase (standard Deno + Hono + Svelte 5 template)
#   - A portable SQL dump importable into any PostgreSQL instance
#   - A SELF_HOSTING.md guide for running the app themselves
#   - A clean CLAUDE.md they can customize via Claude Code
#
# What gets removed:
#   - ALCHEMIST_TENANT_ID / ALCHEMIST_APP_SLUG / ALCHEMIST_DISPATCHER_URL env vars
#   - Promtail sidecar K8s manifest (monitoring/k8s/promtail-sidecar.yml)
#   - Grafana contact point for the Alchemist dispatcher
#   - "Powered by Alchemist AI" branding in CLAUDE.md
#
# This script does NOT drop the platform-side schema or billing record.
# Run deprovision.sh separately once the grace period has passed.
#
# Usage:
#   ./scripts/eject.sh \
#     --tenant-id        <uuid>            \
#     --app-slug         <string>          \
#     --db-url           <string>          \
#     --grafana-url      <string>          \
#     --grafana-token    <string>          \
#     --github-owner     <string>          \
#     --output-dir       <path>            \
#     --confirm                            \
#     [--skip-db-export]                   \
#     [--skip-repo-cleanup]                \
#     [--skip-monitoring-cleanup]          \
#     [--dry-run]
# ===========================================================================

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# ── Color codes ──

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m'

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

log_info() {
  echo -e "${CYAN}[$(timestamp)] INFO:${NC} $1"
}

# ── Parse arguments ──

TENANT_ID=""
APP_SLUG=""
DB_URL=""
GRAFANA_URL=""
GRAFANA_TOKEN=""
GITHUB_OWNER=""
OUTPUT_DIR=""
CONFIRM=false
SKIP_DB_EXPORT=false
SKIP_REPO_CLEANUP=false
SKIP_MONITORING_CLEANUP=false
DRY_RUN=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --tenant-id)                TENANT_ID="$2";       shift 2 ;;
    --app-slug)                 APP_SLUG="$2";        shift 2 ;;
    --db-url)                   DB_URL="$2";          shift 2 ;;
    --grafana-url)              GRAFANA_URL="$2";     shift 2 ;;
    --grafana-token)            GRAFANA_TOKEN="$2";   shift 2 ;;
    --github-owner)             GITHUB_OWNER="$2";    shift 2 ;;
    --output-dir)               OUTPUT_DIR="$2";      shift 2 ;;
    --confirm)                  CONFIRM=true;         shift ;;
    --skip-db-export)           SKIP_DB_EXPORT=true;  shift ;;
    --skip-repo-cleanup)        SKIP_REPO_CLEANUP=true; shift ;;
    --skip-monitoring-cleanup)  SKIP_MONITORING_CLEANUP=true; shift ;;
    --dry-run)                  DRY_RUN=true;         shift ;;
    -h|--help)
      echo "Usage: ./scripts/eject.sh \\"
      echo "  --tenant-id        <uuid>    Alchemist-assigned tenant ID"
      echo "  --app-slug         <string>  URL-safe project slug (e.g., acme-saas)"
      echo "  --db-url           <string>  Shared Postgres connection string (admin)"
      echo "  --grafana-url      <string>  Grafana API URL"
      echo "  --grafana-token    <string>  Grafana service account token"
      echo "  --github-owner     <string>  Customer's GitHub username or org to transfer repo to"
      echo "  --output-dir       <path>    Directory to write DB dump and self-hosting guide"
      echo "  --confirm                    Required flag to authorize destructive actions"
      echo "  [--skip-db-export]           Skip the Postgres dump (if already exported)"
      echo "  [--skip-repo-cleanup]        Skip committing cleanup changes to the repo"
      echo "  [--skip-monitoring-cleanup]  Skip deleting Grafana alerts and contact points"
      echo "  [--dry-run]                  Preview all actions without executing them"
      echo ""
      echo "Note: this script does NOT drop the tenant's platform schema or billing record."
      echo "Run deprovision.sh separately after the grace period has passed."
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
[[ -z "$GITHUB_OWNER" ]]  && MISSING_ARGS+=("--github-owner")
[[ -z "$OUTPUT_DIR" ]]    && MISSING_ARGS+=("--output-dir")

if [[ ${#MISSING_ARGS[@]} -gt 0 ]]; then
  log_err "Missing required arguments: ${MISSING_ARGS[*]}"
  echo ""
  echo "Run with --help for usage."
  exit 1
fi

if [[ "$CONFIRM" != true && "$DRY_RUN" != true ]]; then
  log_err "Refusing to eject without --confirm flag."
  echo ""
  echo "This operation transfers the GitHub repo and deletes Grafana monitoring."
  echo "It cannot be undone without manual intervention."
  echo ""
  echo "Add --confirm to proceed, or --dry-run to preview."
  exit 1
fi

# ── Validate formats ──

UUID_RE='^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
if ! [[ "$TENANT_ID" =~ $UUID_RE ]]; then
  log_err "Invalid --tenant-id: must be a valid UUID"
  exit 1
fi

SLUG_RE='^[a-z0-9][a-z0-9-]*[a-z0-9]$'
SLUG_RE_SHORT='^[a-z0-9]$'
if ! [[ "$APP_SLUG" =~ $SLUG_RE || "$APP_SLUG" =~ $SLUG_RE_SHORT ]]; then
  log_err "Invalid --app-slug: must be lowercase alphanumeric with hyphens"
  exit 1
fi

# ── Check prerequisites ──

MISSING_BINS=()
[[ "$SKIP_DB_EXPORT" == false ]] && ! command -v pg_dump &>/dev/null && MISSING_BINS+=("pg_dump (PostgreSQL client tools)")
[[ "$SKIP_REPO_CLEANUP" == false ]] && ! command -v gh &>/dev/null && MISSING_BINS+=("gh (GitHub CLI: https://cli.github.com/)")
! command -v curl &>/dev/null && MISSING_BINS+=("curl")
! command -v git &>/dev/null && MISSING_BINS+=("git")

if [[ ${#MISSING_BINS[@]} -gt 0 ]]; then
  log_err "Missing required tools:"
  for bin in "${MISSING_BINS[@]}"; do
    echo "  - $bin"
  done
  exit 1
fi

# ── Derived values ──

SCHEMA_NAME="tenant_$(echo "$APP_SLUG" | tr '-' '_')"
REPO_NAME="alchemist-ai/${APP_SLUG}"
GRAFANA_FOLDER_UID="tenant-${APP_SLUG}"
EJECTED_AT="$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
DUMP_FILENAME="${APP_SLUG}-database-$(date -u '+%Y%m%d').sql"

# ── Print plan ──

echo ""
echo "============================================"
echo "  Alchemist Tenant Eject"
echo "============================================"
echo ""
echo "  Tenant ID:       ${TENANT_ID}"
echo "  App slug:        ${APP_SLUG}"
echo "  DB schema:       ${SCHEMA_NAME}"
echo "  Repo:            github.com/${REPO_NAME}"
echo "  Transfer to:     github.com/${GITHUB_OWNER}/${APP_SLUG}"
echo "  Output dir:      ${OUTPUT_DIR}"
echo "  Grafana folder:  ${GRAFANA_FOLDER_UID}"
echo "  Skip DB export:  ${SKIP_DB_EXPORT}"
echo "  Skip repo:       ${SKIP_REPO_CLEANUP}"
echo "  Skip monitoring: ${SKIP_MONITORING_CLEANUP}"
echo "  Dry run:         ${DRY_RUN}"
echo ""
echo "  What will happen:"
[[ "$SKIP_DB_EXPORT" == false ]] &&       echo "    1. Export DB schema ${SCHEMA_NAME} -> ${OUTPUT_DIR}/${DUMP_FILENAME}"
[[ "$SKIP_REPO_CLEANUP" == false ]] && echo "    2. Commit cleanup (remove Alchemist env vars, monitoring, branding)"
[[ "$SKIP_REPO_CLEANUP" == false ]] && echo "    3. Transfer github.com/${REPO_NAME} -> github.com/${GITHUB_OWNER}/${APP_SLUG}"
[[ "$SKIP_MONITORING_CLEANUP" == false ]] && echo "    4. Delete Grafana folder ${GRAFANA_FOLDER_UID} (alerts + dashboards)"
echo "    5. Write self-hosting guide -> ${OUTPUT_DIR}/SELF_HOSTING.md"
echo ""
echo "  What will NOT happen (run deprovision.sh separately):"
echo "    - Drop tenant_${APP_SLUG} schema from shared Postgres"
echo "    - Cancel billing subscription"
echo ""

# ===========================================================================
# Step 1: Create output directory
# ===========================================================================

log_step "Step 1: Preparing output directory..."

if [[ "$DRY_RUN" == true ]]; then
  log_step "[DRY RUN] Would create output directory: ${OUTPUT_DIR}"
else
  mkdir -p "$OUTPUT_DIR"
  log_ok "Output directory ready: ${OUTPUT_DIR}"
fi

# ===========================================================================
# Step 2: Export database
# ===========================================================================

if [[ "$SKIP_DB_EXPORT" == true ]]; then
  log_step "Step 2: Skipping DB export (--skip-db-export set)."
else
  log_step "Step 2: Exporting database schema '${SCHEMA_NAME}'..."

  # Strategy:
  #   1. pg_dump the tenant-scoped schema
  #   2. Rewrite schema references so the dump imports cleanly into 'public'
  #   3. Strip ALCHEMIST_* mentions from the dump (they're only in env vars,
  #      not DB data, but being explicit doesn't hurt)
  #
  # The customer can import this dump into a fresh Postgres database:
  #   createdb myapp
  #   psql myapp < ${DUMP_FILENAME}

  DUMP_PATH="${OUTPUT_DIR}/${DUMP_FILENAME}"

  if [[ "$DRY_RUN" == true ]]; then
    log_step "[DRY RUN] Would run:"
    echo "  pg_dump [DB_URL] \\"
    echo "    --schema=${SCHEMA_NAME} --no-owner --no-acl --no-comments \\"
    echo "    | sed (rename ${SCHEMA_NAME} -> public)"
    echo "    > ${DUMP_PATH}"
  else
    log_info "Dumping schema '${SCHEMA_NAME}' (this may take a moment for large datasets)..."

    # Dump the schema; rewrite all references from tenant_slug -> public schema.
    # Transformations applied:
    #   - Remove the CREATE SCHEMA line (public already exists in target DBs)
    #   - Rewrite SET search_path directives
    #   - Rewrite schema-qualified identifiers (e.g. tenant_acme_saas.users -> public.users)
    #   - Remove any \connect directives (we're not restoring to a specific DB)
    pg_dump "$DB_URL" \
      --schema="${SCHEMA_NAME}" \
      --no-owner \
      --no-acl \
      --no-comments \
      --format=plain \
      | sed \
          -e "/^CREATE SCHEMA ${SCHEMA_NAME};$/d" \
          -e "s/^SET search_path = ${SCHEMA_NAME}/SET search_path = public/g" \
          -e "s/^\\\\connect .*$/-- (database connection removed -- connect to your own database before importing)/g" \
          -e "s/${SCHEMA_NAME}\./public./g" \
      > "$DUMP_PATH"

    DUMP_SIZE=$(du -sh "$DUMP_PATH" 2>/dev/null | cut -f1)
    log_ok "Database exported: ${DUMP_PATH} (${DUMP_SIZE})"
    log_info "Import with: psql YOUR_DATABASE_URL < ${DUMP_FILENAME}"
  fi
fi

# ===========================================================================
# Step 3: Clone repo, apply cleanup commits, push
# ===========================================================================

if [[ "$SKIP_REPO_CLEANUP" == true ]]; then
  log_step "Step 3: Skipping repo cleanup (--skip-repo-cleanup set)."
  SKIP_TRANSFER=true
else
  log_step "Step 3: Applying cleanup commits to repo..."

  WORK_DIR="$(mktemp -d)"
  trap 'rm -rf "$WORK_DIR"' EXIT

  if [[ "$DRY_RUN" == true ]]; then
    log_step "[DRY RUN] Would clone github.com/${REPO_NAME} -> ${WORK_DIR}/${APP_SLUG}"
    log_step "[DRY RUN] Would commit the following changes:"
    echo "  - CLAUDE.md: remove 'Powered by Alchemist AI' line"
    echo "  - .env.example: remove ALCHEMIST_TENANT_ID, ALCHEMIST_APP_SLUG, ALCHEMIST_DISPATCHER_URL"
    echo "  - monitoring/k8s/promtail-sidecar.yml: delete file"
    echo "  - monitoring/grafana/contact-points/alchemist-dispatcher.yml: delete file"
    echo "  - monitoring/grafana/alerts/: delete (Alchemist-hosted Grafana alerts)"
    echo "  - SELF_HOSTING.md: create self-hosting guide"
    log_step "[DRY RUN] Would push cleanup commits to staging branch"
    SKIP_TRANSFER=false
  else
    # Check GitHub CLI is authenticated
    if ! gh auth status &>/dev/null; then
      log_err "GitHub CLI is not authenticated. Run: gh auth login"
      exit 1
    fi

    # Verify the repo exists before doing anything else
    if ! gh repo view "$REPO_NAME" &>/dev/null; then
      log_err "Repo not found: github.com/${REPO_NAME}"
      log_err "Verify the repo exists and GITHUB_TOKEN has access."
      exit 1
    fi

    log_info "Cloning ${REPO_NAME}..."
    REPO_DIR="${WORK_DIR}/${APP_SLUG}"
    gh repo clone "$REPO_NAME" "$REPO_DIR" -- --quiet

    cd "$REPO_DIR"
    git checkout staging 2>/dev/null || git checkout main 2>/dev/null || true

    # ── 3a: Clean CLAUDE.md ──

    if [[ -f "CLAUDE.md" ]]; then
      log_info "  Cleaning CLAUDE.md..."
      # Remove the "Powered by Alchemist AI" branding line and any trailing blank line after it
      sed -i.bak '/^\*\*Powered by Alchemist AI\*\*.*/d' CLAUDE.md
      rm -f CLAUDE.md.bak
      log_ok "  CLAUDE.md: Alchemist branding removed"
    else
      log_warn "  CLAUDE.md not found -- skipping"
    fi

    # ── 3b: Clean .env.example ──

    if [[ -f ".env.example" ]]; then
      log_info "  Cleaning .env.example..."
      # Remove the ALCHEMIST_* block (3 env vars + any blank separator line above them)
      sed -i.bak \
        -e '/^ALCHEMIST_TENANT_ID=/d' \
        -e '/^ALCHEMIST_APP_SLUG=/d' \
        -e '/^ALCHEMIST_DISPATCHER_URL=/d' \
        -e '/^ALCHEMIST_DISPATCHER_TOKEN=/d' \
        -e '/^# Alchemist platform/d' \
        .env.example
      rm -f .env.example.bak
      log_ok "  .env.example: ALCHEMIST_* env vars removed"
    else
      log_warn "  .env.example not found -- skipping"
    fi

    # ── 3c: Remove Promtail sidecar manifest ──

    PROMTAIL_MANIFEST="monitoring/k8s/promtail-sidecar.yml"
    if [[ -f "$PROMTAIL_MANIFEST" ]]; then
      log_info "  Removing Promtail sidecar manifest..."
      git rm -f "$PROMTAIL_MANIFEST" 2>/dev/null || rm -f "$PROMTAIL_MANIFEST"
      log_ok "  ${PROMTAIL_MANIFEST}: removed"
    fi

    # Remove the k8s monitoring dir if now empty
    if [[ -d "monitoring/k8s" ]] && [[ -z "$(ls -A monitoring/k8s)" ]]; then
      rmdir monitoring/k8s
    fi

    # ── 3d: Remove Alchemist dispatcher contact point ──

    CONTACT_POINT="monitoring/grafana/contact-points/alchemist-dispatcher.yml"
    if [[ -f "$CONTACT_POINT" ]]; then
      log_info "  Removing Alchemist dispatcher contact point..."
      git rm -f "$CONTACT_POINT" 2>/dev/null || rm -f "$CONTACT_POINT"
      log_ok "  ${CONTACT_POINT}: removed"
    fi

    # Remove the contact-points dir if now empty
    if [[ -d "monitoring/grafana/contact-points" ]] && [[ -z "$(ls -A monitoring/grafana/contact-points)" ]]; then
      rmdir monitoring/grafana/contact-points 2>/dev/null || true
    fi

    # ── 3e: Remove Alchemist-managed alert rules ──
    # The customer is taking over -- they won't have access to the shared
    # Grafana instance. Remove the rule files so they don't cause confusion.
    # They can set up their own Grafana instance and re-add alerts from scratch.

    ALERTS_DIR="monitoring/grafana/alerts"
    if [[ -d "$ALERTS_DIR" ]]; then
      log_info "  Archiving Alchemist-managed Grafana alert rules..."
      # Move into an "examples" directory so the customer can reference them
      # when setting up their own Grafana, rather than deleting entirely.
      mkdir -p "monitoring/grafana/alert-examples"
      find "$ALERTS_DIR" -maxdepth 1 -name "*.yml" -o -name "*.yaml" | while IFS= read -r alert_file; do
        [[ -f "$alert_file" ]] || continue
        git mv "$alert_file" "monitoring/grafana/alert-examples/$(basename "$alert_file")" 2>/dev/null \
          || mv "$alert_file" "monitoring/grafana/alert-examples/$(basename "$alert_file")"
      done
      # Remove now-empty alerts dir
      rmdir "$ALERTS_DIR" 2>/dev/null || true
      log_ok "  Grafana alert rules moved to monitoring/grafana/alert-examples/ for reference"
    fi

    # ── 3f: Remove Promtail config (no longer needed without the sidecar) ──

    PROMTAIL_CONFIG="monitoring/promtail/config.yml"
    if [[ -f "$PROMTAIL_CONFIG" ]]; then
      log_info "  Archiving Promtail config for reference..."
      mkdir -p "monitoring/grafana/alert-examples"
      git mv "$PROMTAIL_CONFIG" "monitoring/promtail/config.example.yml" 2>/dev/null \
        || mv "$PROMTAIL_CONFIG" "monitoring/promtail/config.example.yml"
      # Update the example to note it's a reference file
      sed -i.bak '1i # REFERENCE ONLY -- Promtail config used when hosted on Alchemist platform.\n# Set up your own Promtail/Loki stack to use this.\n' \
        monitoring/promtail/config.example.yml 2>/dev/null || true
      rm -f monitoring/promtail/config.example.yml.bak
      log_ok "  Promtail config archived as monitoring/promtail/config.example.yml"
    fi

    # ── 3g: Write SELF_HOSTING.md ──

    log_info "  Writing SELF_HOSTING.md..."
    cat > SELF_HOSTING.md <<GUIDE
# Self-Hosting Guide

This project was ejected from Alchemist AI on ${EJECTED_AT}.
It is a standard Deno + Hono + Svelte 5 SPA that runs anywhere.

## What Changed During Eject

- Removed Alchemist-specific env vars (\`ALCHEMIST_TENANT_ID\`, \`ALCHEMIST_APP_SLUG\`)
- Removed Promtail sidecar (was shipping logs to Alchemist's shared Loki instance)
- Removed Grafana contact point (was routing alerts to Alchemist's ticket dispatcher)
- Grafana alert rules moved to \`monitoring/grafana/alert-examples/\` for reference
- Removed "Powered by Alchemist AI" from CLAUDE.md

## Prerequisites

- [Deno](https://deno.land/) >= 1.40
- [Docker](https://docs.docker.com/get-docker/) (for local Postgres + Redis)
- [Node.js](https://nodejs.org/) >= 18 (for Vite frontend build)

## Database Import

A portable SQL dump was exported at eject time.
Import it into a fresh PostgreSQL database:

\`\`\`bash
# Create a new database
createdb myapp

# Import the dump (already converted from schema-scoped to public schema)
psql myapp < ${APP_SLUG}-database-*.sql
\`\`\`

If you prefer a fresh start, the migration files are in \`db/migrations/\`.
Run them with:

\`\`\`bash
DATABASE_URL=postgres://... deno task db:migrate
\`\`\`

## Local Development

\`\`\`bash
# 1. Copy and edit environment variables
cp .env.example .env
# Edit .env with your DATABASE_URL, Redis URL, session secrets, etc.

# 2. Start the dev stack (Postgres + Redis via Docker, then Deno API + Vite)
./scripts/dev.sh --api-port 8000 --port 5173

# 3. Open http://localhost:5173
\`\`\`

## Environment Variables

Copy \`.env.example\` to \`.env\` and fill in:

| Variable | Description |
|----------|-------------|
| \`DATABASE_URL\` | PostgreSQL connection string |
| \`REDIS_URL\` | Redis connection string |
| \`SESSION_SECRET\` | Long random string for session signing |
| \`JWT_SECRET\` | Long random string for JWT signing |

See \`.env.example\` for the full list.

## Production Deployment

### Docker / Kubernetes

The app runs as a single Deno process. Build the Docker image:

\`\`\`bash
docker build -t ${APP_SLUG} .
docker run -p 8000:8000 --env-file .env ${APP_SLUG}
\`\`\`

Kubernetes manifests are not included in this template -- you'll need to write
your own Deployment + Service + Ingress resources. The app exposes a single
HTTP port (default 8000, set via \`PORT\` env var).

### Fly.io (quickest path)

\`\`\`bash
fly launch        # generates fly.toml
fly postgres create --name ${APP_SLUG}-db
fly postgres attach --app ${APP_SLUG} ${APP_SLUG}-db
fly secrets set SESSION_SECRET=... JWT_SECRET=...
fly deploy
\`\`\`

### Railway

1. Connect your GitHub repo in the Railway dashboard
2. Set env vars in the Railway UI
3. Deploy

## Monitoring (Optional)

The exported Grafana alert rule examples are in
\`monitoring/grafana/alert-examples/\`. To use them:

1. Run your own Grafana instance
2. Set up [Loki](https://grafana.com/docs/loki/) for log aggregation
3. Run Promtail alongside your app (reference config in \`monitoring/promtail/config.example.yml\`)
4. Import the alert rules via the Grafana API

Alternatively, ship logs to any structured logging destination (Datadog,
Logtail, Axiom, etc.) and recreate the alert logic there.

## Vibe Coding with Claude Code

This project ships with a \`CLAUDE.md\` that gives Claude Code the full
context it needs to work on your app effectively. Recommended workflow:

\`\`\`bash
# Install Claude Code
npm install -g @anthropic-ai/claude-code

# Start a session
claude
\`\`\`

Claude Code will read \`CLAUDE.md\` automatically and understand the project
structure, conventions, and critical rules.

---

*Ejected from Alchemist AI on ${EJECTED_AT}*
GUIDE

    log_ok "  SELF_HOSTING.md written"

    # ── 3h: Commit everything ──

    log_info "  Committing cleanup..."
    git add -A
    git diff --cached --quiet && { log_warn "  Nothing to commit -- repo already clean"; } || {
      git commit -m "chore: eject from Alchemist AI

Remove Alchemist platform dependencies:
- ALCHEMIST_* env vars removed from .env.example
- Promtail sidecar manifest removed (monitoring/k8s/)
- Grafana dispatcher contact point removed
- Grafana alert rules archived to monitoring/grafana/alert-examples/ for reference
- 'Powered by Alchemist AI' branding removed from CLAUDE.md
- SELF_HOSTING.md added with self-hosting instructions

The app is now a standalone Deno + Hono + Svelte 5 project.
See SELF_HOSTING.md to run it independently."
      log_ok "  Cleanup committed to git"
    }

    # Push to GitHub before transferring ownership
    log_info "  Pushing cleanup commits..."
    git push origin HEAD 2>/dev/null && log_ok "  Pushed" || log_warn "  Push failed -- continuing with transfer anyway"

    cd "$SCRIPT_DIR"
    SKIP_TRANSFER=false
  fi
fi

# ===========================================================================
# Step 4: Transfer GitHub repository to the customer
# ===========================================================================

if [[ "${SKIP_TRANSFER:-false}" == true || "$SKIP_REPO_CLEANUP" == true ]]; then
  if [[ "$SKIP_REPO_CLEANUP" == true ]]; then
    log_step "Step 4: Skipping repo transfer (--skip-repo-cleanup set implies no transfer)."
  fi
else
  log_step "Step 4: Transferring repo to ${GITHUB_OWNER}..."

  if [[ "$DRY_RUN" == true ]]; then
    log_step "[DRY RUN] Would call:"
    echo "  POST https://api.github.com/repos/${REPO_NAME}/transfer"
    echo "  { \"new_owner\": \"${GITHUB_OWNER}\" }"
  else
    TRANSFER_RESPONSE=$(curl -s -w "\n%{http_code}" \
      -X POST \
      -H "Authorization: Bearer ${GITHUB_TOKEN:-$(gh auth token 2>/dev/null || echo "")}" \
      -H "Accept: application/vnd.github+json" \
      -H "Content-Type: application/json" \
      -d "{\"new_owner\": \"${GITHUB_OWNER}\"}" \
      "https://api.github.com/repos/${REPO_NAME}/transfer")

    TRANSFER_HTTP_CODE=$(echo "$TRANSFER_RESPONSE" | tail -1)
    TRANSFER_BODY=$(echo "$TRANSFER_RESPONSE" | sed '$d')

    if [[ "$TRANSFER_HTTP_CODE" == "202" ]]; then
      NEW_REPO_URL="https://github.com/${GITHUB_OWNER}/${APP_SLUG}"
      log_ok "Transfer initiated. The repo will be available at: ${NEW_REPO_URL}"
      log_info "  Note: GitHub transfer takes a few seconds to complete. The customer"
      log_info "  will receive an email confirmation at their GitHub-registered address."
    else
      log_warn "Repo transfer returned HTTP ${TRANSFER_HTTP_CODE}. Manual transfer may be needed."
      log_warn "Response: ${TRANSFER_BODY}"
      log_info "Manual transfer: go to https://github.com/${REPO_NAME}/settings"
      log_info "  then Danger Zone -> Transfer this repository -> ${GITHUB_OWNER}"
    fi
  fi
fi

# ===========================================================================
# Step 5: Delete Grafana monitoring
# ===========================================================================

if [[ "$SKIP_MONITORING_CLEANUP" == true ]]; then
  log_step "Step 5: Skipping Grafana cleanup (--skip-monitoring-cleanup set)."
else
  log_step "Step 5: Deleting Grafana monitoring for tenant '${APP_SLUG}'..."

  if [[ "$DRY_RUN" == true ]]; then
    log_step "[DRY RUN] Would DELETE ${GRAFANA_URL}/api/folders/${GRAFANA_FOLDER_UID}?forceDeleteRules=true"
    log_step "[DRY RUN] Would DELETE ${GRAFANA_URL}/api/v1/provisioning/contact-points/alchemist-dispatcher-${APP_SLUG}"
  else
    # Delete the Grafana folder (cascades dashboards + alert rules)
    FOLDER_CHECK=$(curl -s -o /dev/null -w "%{http_code}" \
      -H "Authorization: Bearer ${GRAFANA_TOKEN}" \
      "${GRAFANA_URL}/api/folders/${GRAFANA_FOLDER_UID}")

    if [[ "$FOLDER_CHECK" == "200" ]]; then
      DELETE_RESPONSE=$(curl -s -w "\n%{http_code}" \
        -X DELETE \
        -H "Authorization: Bearer ${GRAFANA_TOKEN}" \
        "${GRAFANA_URL}/api/folders/${GRAFANA_FOLDER_UID}?forceDeleteRules=true")

      DELETE_HTTP_CODE=$(echo "$DELETE_RESPONSE" | tail -1)
      if [[ "$DELETE_HTTP_CODE" == "200" || "$DELETE_HTTP_CODE" == "204" ]]; then
        log_ok "Grafana folder '${GRAFANA_FOLDER_UID}' deleted (dashboards + alerts)."
      else
        DELETE_BODY=$(echo "$DELETE_RESPONSE" | sed '$d')
        log_warn "Failed to delete Grafana folder (HTTP ${DELETE_HTTP_CODE}): ${DELETE_BODY}"
      fi
    elif [[ "$FOLDER_CHECK" == "404" ]]; then
      log_warn "Grafana folder '${GRAFANA_FOLDER_UID}' not found -- already deleted or never created."
    else
      log_warn "Could not check Grafana folder (HTTP ${FOLDER_CHECK}). Skipping."
    fi

    # Delete the tenant-specific contact point
    CP_DELETE_CODE=$(curl -s -o /dev/null -w "%{http_code}" \
      -X DELETE \
      -H "Authorization: Bearer ${GRAFANA_TOKEN}" \
      "${GRAFANA_URL}/api/v1/provisioning/contact-points/alchemist-dispatcher-${APP_SLUG}")

    if [[ "$CP_DELETE_CODE" == "202" || "$CP_DELETE_CODE" == "204" ]]; then
      log_ok "Contact point 'alchemist-dispatcher-${APP_SLUG}' deleted."
    elif [[ "$CP_DELETE_CODE" == "404" ]]; then
      log_warn "Contact point not found -- may have been removed with the folder."
    else
      log_warn "Contact point deletion returned HTTP ${CP_DELETE_CODE}. Continuing."
    fi
  fi
fi

# ===========================================================================
# Step 6: Write self-hosting guide to output dir
# ===========================================================================

log_step "Step 6: Writing self-hosting guide to output directory..."

GUIDE_PATH="${OUTPUT_DIR}/SELF_HOSTING.md"

if [[ "$DRY_RUN" == true ]]; then
  log_step "[DRY RUN] Would write self-hosting guide to ${GUIDE_PATH}"
else
  # Write a copy to the output directory (the repo version is the canonical one,
  # but the output dir gives the platform team an easy place to email the customer)
  cat > "$GUIDE_PATH" <<GUIDE
# ${APP_SLUG} — Self-Hosting Guide

Your project was ejected from Alchemist AI on ${EJECTED_AT}.

## What You Received

- **GitHub repo**: https://github.com/${GITHUB_OWNER}/${APP_SLUG}
  (transferred from the Alchemist platform)

- **Database dump**: \`${DUMP_FILENAME}\`
  Contains all your application data, ready to import into any PostgreSQL instance.
  Already converted from the multi-tenant schema to standalone \`public\` schema.

## Quick Start

\`\`\`bash
# 1. Clone your repo
git clone https://github.com/${GITHUB_OWNER}/${APP_SLUG}
cd ${APP_SLUG}

# 2. Copy env vars and fill them in
cp .env.example .env

# 3. Import your database
createdb ${APP_SLUG}
psql ${APP_SLUG} < ${DUMP_FILENAME}

# 4. Start the dev stack
./scripts/dev.sh --api-port 8000 --port 5173
\`\`\`

## Environment Variables to Configure

| Variable | Where to get it |
|----------|----------------|
| \`DATABASE_URL\` | Your PostgreSQL connection string |
| \`REDIS_URL\` | Your Redis connection string |
| \`SESSION_SECRET\` | Run: \`openssl rand -hex 32\` |
| \`JWT_SECRET\` | Run: \`openssl rand -hex 32\` |

See \`.env.example\` in the repo for the full list.

## Recommended Hosting Platforms

- **Fly.io**: Great for Deno apps, easy Postgres integration
- **Railway**: Zero-config deploys from GitHub
- **Render**: Similar to Railway, generous free tier
- **Self-hosted**: Docker on any VPS (DigitalOcean, Hetzner, etc.)

## Vibe Coding

The repo includes a \`CLAUDE.md\` that gives Claude Code full context about
your project. Just run \`claude\` in the project directory.

---

*Ejected from Alchemist AI on ${EJECTED_AT}*
*Tenant ID: ${TENANT_ID} (keep for billing/support reference)*
GUIDE

  log_ok "Self-hosting guide written: ${GUIDE_PATH}"
fi

# ── Done ──

echo ""
echo -e "${GREEN}============================================${NC}"
echo -e "${GREEN}  Eject complete for '${APP_SLUG}'${NC}"
echo -e "${GREEN}============================================${NC}"
echo ""

if [[ "$DRY_RUN" == false ]]; then
  echo "  What was done:"
  [[ "$SKIP_DB_EXPORT" == false ]]        && echo "    DB dump:     ${OUTPUT_DIR}/${DUMP_FILENAME}"
  [[ "$SKIP_REPO_CLEANUP" == false ]]     && echo "    Repo:        https://github.com/${GITHUB_OWNER}/${APP_SLUG} (transferred)"
  [[ "$SKIP_MONITORING_CLEANUP" == false ]] && echo "    Grafana:     folder '${GRAFANA_FOLDER_UID}' deleted"
  echo "    Guide:       ${OUTPUT_DIR}/SELF_HOSTING.md"
  echo ""
  echo -e "${YELLOW}  What to do next:${NC}"
  echo "    1. Email the customer the DB dump and SELF_HOSTING.md"
  echo "    2. Cancel their Alchemist billing subscription"
  echo "    3. Run deprovision.sh after the grace period to clean up the platform DB:"
  echo ""
  echo "       ./scripts/deprovision.sh \\"
  echo "         --tenant-id ${TENANT_ID} \\"
  echo "         --app-slug ${APP_SLUG} \\"
  echo "         --db-url [DB_URL] \\"
  echo "         --grafana-url ${GRAFANA_URL} \\"
  echo "         --grafana-token [GRAFANA_TOKEN] \\"
  echo "         --confirm"
  echo ""
else
  echo "  Dry run complete. Add --confirm to execute."
fi

echo "  Timestamp: ${EJECTED_AT}"
echo ""
